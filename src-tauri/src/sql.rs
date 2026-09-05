use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::{
    Column, Executor, Row, Sqlite, SqlitePool, Transaction, TypeInfo, Value, ValueRef,
    query::Query,
    sqlite::{SqliteArguments, SqliteRow, SqliteValueRef},
};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use time::{Date, PrimitiveDateTime, Time};
use tokio::sync::{Mutex, RwLock};
use tokio::time::timeout;

#[cfg(not(test))]
const SQL_TRANSACTION_STATEMENT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const SQL_TRANSACTION_STATEMENT_TIMEOUT: Duration = Duration::from_millis(10);
const SQL_TRANSACTION_ROLLBACK_TIMEOUT: Duration = Duration::from_secs(5);

struct SqlTransaction {
    transaction: Mutex<Option<Transaction<'static, Sqlite>>>,
}

impl SqlTransaction {
    async fn begin(pool: &SqlitePool) -> Result<Self, String> {
        let transaction = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            transaction: Mutex::new(Some(transaction)),
        })
    }

    async fn execute(&self, query: &str, values: Vec<JsonValue>) -> Result<QueryResult, String> {
        let mut transaction = self.transaction.lock().await;
        let transaction = transaction
            .as_mut()
            .ok_or_else(|| "SQL transaction is no longer active".to_owned())?;
        execute_on(&mut **transaction, query, values).await
    }

    async fn select(&self, query: &str, values: Vec<JsonValue>) -> Result<Vec<JsonValue>, String> {
        let mut transaction = self.transaction.lock().await;
        let transaction = transaction
            .as_mut()
            .ok_or_else(|| "SQL transaction is no longer active".to_owned())?;
        select_on(&mut **transaction, query, values).await
    }

    async fn commit(&self) -> Result<(), String> {
        let transaction = self
            .transaction
            .lock()
            .await
            .take()
            .ok_or_else(|| "SQL transaction is no longer active".to_owned())?;
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
    }

    async fn rollback(&self) -> Result<(), String> {
        let transaction = self
            .transaction
            .lock()
            .await
            .take()
            .ok_or_else(|| "SQL transaction is no longer active".to_owned())?;
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())
    }
}

pub(crate) struct SqlTransactions {
    next_id: AtomicU32,
    transactions: RwLock<HashMap<u32, Arc<SqlTransaction>>>,
}

impl Default for SqlTransactions {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            transactions: RwLock::new(HashMap::new()),
        }
    }
}

impl SqlTransactions {
    async fn begin(&self, pool: &SqlitePool) -> Result<u32, String> {
        let transaction = Arc::new(SqlTransaction::begin(pool).await?);
        let mut transactions = self.transactions.write().await;
        loop {
            let transaction_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            if let std::collections::hash_map::Entry::Vacant(entry) =
                transactions.entry(transaction_id)
            {
                entry.insert(transaction);
                return Ok(transaction_id);
            }
        }
    }

    async fn execute(
        &self,
        transaction_id: u32,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<QueryResult, String> {
        let transaction = self.get(transaction_id).await?;
        match timeout(
            SQL_TRANSACTION_STATEMENT_TIMEOUT,
            transaction.execute(query, values),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(self.abort_timed_out(transaction_id, "execute").await),
        }
    }

    async fn select(
        &self,
        transaction_id: u32,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<Vec<JsonValue>, String> {
        let transaction = self.get(transaction_id).await?;
        match timeout(
            SQL_TRANSACTION_STATEMENT_TIMEOUT,
            transaction.select(query, values),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(self.abort_timed_out(transaction_id, "select").await),
        }
    }

    async fn commit(&self, transaction_id: u32) -> Result<(), String> {
        self.remove(transaction_id).await?.commit().await
    }

    async fn rollback(&self, transaction_id: u32) -> Result<(), String> {
        let Some(transaction) = self.transactions.write().await.remove(&transaction_id) else {
            return Ok(());
        };
        transaction.rollback().await
    }

    async fn abort_timed_out(&self, transaction_id: u32, operation: &str) -> String {
        let rollback = timeout(
            SQL_TRANSACTION_ROLLBACK_TIMEOUT,
            self.rollback(transaction_id),
        )
        .await;
        let timeout_seconds = SQL_TRANSACTION_STATEMENT_TIMEOUT.as_secs_f64();
        match rollback {
            Ok(Ok(())) => format!(
                "SQL transaction {transaction_id} {operation} timed out after {timeout_seconds} seconds and was rolled back"
            ),
            Ok(Err(error)) => format!(
                "SQL transaction {transaction_id} {operation} timed out after {timeout_seconds} seconds; rollback failed: {error}"
            ),
            Err(_) => format!(
                "SQL transaction {transaction_id} {operation} timed out after {timeout_seconds} seconds; rollback also timed out"
            ),
        }
    }

    async fn get(&self, transaction_id: u32) -> Result<Arc<SqlTransaction>, String> {
        self.transactions
            .read()
            .await
            .get(&transaction_id)
            .cloned()
            .ok_or_else(|| format!("SQL transaction {transaction_id} is not active"))
    }

    async fn remove(&self, transaction_id: u32) -> Result<Arc<SqlTransaction>, String> {
        self.transactions
            .write()
            .await
            .remove(&transaction_id)
            .ok_or_else(|| format!("SQL transaction {transaction_id} is not active"))
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryResult {
    rows_affected: u64,
    last_insert_id: i64,
}

#[tauri::command]
pub(crate) async fn sql_begin_transaction(
    db_instances: State<'_, DbInstances>,
    transactions: State<'_, SqlTransactions>,
    db: String,
) -> Result<u32, String> {
    let pool = {
        let instances = db_instances.0.read().await;
        let db = instances
            .get(&db)
            .ok_or_else(|| format!("Database not loaded: {db}"))?;
        #[allow(unreachable_patterns)]
        match db {
            DbPool::Sqlite(pool) => pool.clone(),
            _ => return Err("SQL transactions are only supported for SQLite".to_owned()),
        }
    };
    transactions.begin(&pool).await
}

#[tauri::command]
pub(crate) async fn sql_execute(
    transactions: State<'_, SqlTransactions>,
    transaction_id: u32,
    query: String,
    values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    transactions.execute(transaction_id, &query, values).await
}

#[tauri::command]
pub(crate) async fn sql_select(
    transactions: State<'_, SqlTransactions>,
    transaction_id: u32,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    transactions.select(transaction_id, &query, values).await
}

#[tauri::command]
pub(crate) async fn sql_commit_transaction(
    transactions: State<'_, SqlTransactions>,
    transaction_id: u32,
) -> Result<(), String> {
    transactions.commit(transaction_id).await
}

#[tauri::command]
pub(crate) async fn sql_rollback_transaction(
    transactions: State<'_, SqlTransactions>,
    transaction_id: u32,
) -> Result<(), String> {
    transactions.rollback(transaction_id).await
}

async fn execute_on<'e, E>(
    executor: E,
    query: &str,
    values: Vec<JsonValue>,
) -> Result<QueryResult, String>
where
    E: Executor<'e, Database = Sqlite>,
{
    let result = executor
        .execute(bind_values(query, values))
        .await
        .map_err(|error| error.to_string())?;
    Ok(QueryResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

async fn select_on<'e, E>(
    executor: E,
    query: &str,
    values: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, String>
where
    E: Executor<'e, Database = Sqlite>,
{
    let rows: Vec<SqliteRow> = executor
        .fetch_all(bind_values(query, values))
        .await
        .map_err(|error| error.to_string())?;
    rows.into_iter().map(row_to_json).collect()
}

fn bind_values<'q>(
    query: &'q str,
    values: Vec<JsonValue>,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    let mut query = sqlx::query(query);
    for value in values {
        if value.is_null() {
            query = query.bind(None::<JsonValue>);
        } else if let Some(value) = value.as_str() {
            query = query.bind(value.to_owned());
        } else if let Some(value) = value.as_number() {
            query = query.bind(value.as_f64().unwrap_or_default());
        } else {
            query = query.bind(value);
        }
    }
    query
}

fn row_to_json(row: SqliteRow) -> Result<JsonValue, String> {
    let mut result = JsonMap::new();
    for (index, column) in row.columns().iter().enumerate() {
        let value = row.try_get_raw(index).map_err(|error| error.to_string())?;
        result.insert(column.name().to_owned(), value_to_json(value)?);
    }
    Ok(JsonValue::Object(result))
}

fn value_to_json(value: SqliteValueRef<'_>) -> Result<JsonValue, String> {
    if value.is_null() {
        return Ok(JsonValue::Null);
    }

    let result = match value.type_info().name() {
        "TEXT" => value
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
        "REAL" => value
            .to_owned()
            .try_decode::<f64>()
            .ok()
            .and_then(|value| serde_json::Number::from_f64(value).map(JsonValue::Number))
            .unwrap_or(JsonValue::Null),
        "INTEGER" | "NUMERIC" => value
            .to_owned()
            .try_decode::<i64>()
            .map(|value| JsonValue::Number(value.into()))
            .unwrap_or(JsonValue::Null),
        "BOOLEAN" => value
            .to_owned()
            .try_decode::<bool>()
            .map(JsonValue::Bool)
            .unwrap_or(JsonValue::Null),
        "DATE" => value
            .to_owned()
            .try_decode::<Date>()
            .map(|value| JsonValue::String(value.to_string()))
            .unwrap_or(JsonValue::Null),
        "TIME" => value
            .to_owned()
            .try_decode::<Time>()
            .map(|value| JsonValue::String(value.to_string()))
            .unwrap_or(JsonValue::Null),
        "DATETIME" => value
            .to_owned()
            .try_decode::<PrimitiveDateTime>()
            .map(|value| JsonValue::String(value.to_string()))
            .unwrap_or(JsonValue::Null),
        "BLOB" => value
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|value| {
                JsonValue::Array(
                    value
                        .into_iter()
                        .map(|byte| JsonValue::Number(byte.into()))
                        .collect(),
                )
            })
            .unwrap_or(JsonValue::Null),
        "NULL" => JsonValue::Null,
        data_type => return Err(format!("Unsupported SQLite data type: {data_type}")),
    };

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{SqlTransaction, SqlTransactions, execute_on, select_on};
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{sync::Arc, time::Duration};

    #[test]
    fn rollback_removes_every_write_from_a_transaction() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            execute_on(
                &pool,
                "CREATE TABLE recovery_units (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
                vec![],
            )
            .await
            .unwrap();

            let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            execute_on(
                &mut *transaction,
                "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                vec![json!(7), json!("staged")],
            )
            .await
            .unwrap();

            let staged = select_on(
                &mut *transaction,
                "SELECT id, state FROM recovery_units",
                vec![],
            )
            .await
            .unwrap();
            assert_eq!(staged, vec![json!({ "id": 7, "state": "staged" })]);

            transaction.rollback().await.unwrap();

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }

    #[test]
    fn committed_transaction_persists_and_cannot_be_reused() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            execute_on(
                &pool,
                "CREATE TABLE recovery_units (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
                vec![],
            )
            .await
            .unwrap();

            let transaction = SqlTransaction::begin(&pool).await.unwrap();
            transaction
                .execute(
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(8), json!("committed")],
                )
                .await
                .unwrap();
            transaction.commit().await.unwrap();

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert_eq!(durable, vec![json!({ "id": 8, "state": "committed" })]);

            let error = transaction
                .select("SELECT id FROM recovery_units", vec![])
                .await
                .unwrap_err();
            assert_eq!(error, "SQL transaction is no longer active");
        });
    }

    #[test]
    fn transaction_id_routes_reads_and_writes_to_the_same_transaction() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(2)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            execute_on(
                &pool,
                "CREATE TABLE recovery_units (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
                vec![],
            )
            .await
            .unwrap();

            let transactions = SqlTransactions::default();
            let transaction_id = transactions.begin(&pool).await.unwrap();
            transactions
                .execute(
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(9), json!("pending")],
                )
                .await
                .unwrap();

            let pending = transactions
                .select(
                    transaction_id,
                    "SELECT id, state FROM recovery_units",
                    vec![],
                )
                .await
                .unwrap();
            assert_eq!(pending, vec![json!({ "id": 9, "state": "pending" })]);

            transactions.rollback(transaction_id).await.unwrap();

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }

    #[test]
    fn timed_out_statement_rolls_back_and_invalidates_transaction() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            execute_on(
                &pool,
                "CREATE TABLE recovery_units (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
                vec![],
            )
            .await
            .unwrap();

            let transactions = Arc::new(SqlTransactions::default());
            let transaction_id = transactions.begin(&pool).await.unwrap();
            transactions
                .execute(
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(10), json!("pending")],
                )
                .await
                .unwrap();

            let transaction = transactions.get(transaction_id).await.unwrap();
            let transaction_guard = transaction.transaction.lock().await;
            let pending_select = {
                let transactions = Arc::clone(&transactions);
                tauri::async_runtime::spawn(async move {
                    transactions
                        .select(transaction_id, "SELECT id FROM recovery_units", vec![])
                        .await
                })
            };
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
            drop(transaction_guard);

            let error = pending_select.await.unwrap().unwrap_err();
            assert!(error.contains("timed out"));
            assert!(transactions.get(transaction_id).await.is_err());

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }
}
