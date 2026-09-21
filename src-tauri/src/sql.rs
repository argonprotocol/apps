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
    time::{Duration, Instant},
};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use time::{Date, PrimitiveDateTime, Time};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
use tokio::time::timeout;

#[cfg(not(test))]
const SQL_TRANSACTION_STATEMENT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const SQL_TRANSACTION_STATEMENT_TIMEOUT: Duration = Duration::from_millis(10);
const SQL_TRANSACTION_ROLLBACK_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(test))]
const SQL_TRANSACTION_LIFETIME_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const SQL_TRANSACTION_LIFETIME_TIMEOUT: Duration = Duration::from_millis(50);
const SQL_WRITER_WAIT_WARN: Duration = Duration::from_secs(1);
const SQL_WRITER_HOLD_WARN: Duration = Duration::from_secs(5);

struct SqlTransaction {
    transaction: Mutex<Option<Transaction<'static, Sqlite>>>,
    writer: Mutex<Option<OwnedMutexGuard<()>>>,
    started_at: Instant,
}

impl SqlTransaction {
    async fn begin(pool: &SqlitePool, writer: OwnedMutexGuard<()>) -> Result<Self, String> {
        let transaction = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            transaction: Mutex::new(Some(transaction)),
            writer: Mutex::new(Some(writer)),
            started_at: Instant::now(),
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
        let result = transaction
            .commit()
            .await
            .map_err(|error| error.to_string());
        self.finish("committed").await;
        result
    }

    async fn rollback(&self) -> Result<(), String> {
        let transaction = self
            .transaction
            .lock()
            .await
            .take()
            .ok_or_else(|| "SQL transaction is no longer active".to_owned())?;
        let result = transaction
            .rollback()
            .await
            .map_err(|error| error.to_string());
        self.finish("rolled back").await;
        result
    }

    async fn finish(&self, outcome: &str) {
        self.writer.lock().await.take();
        let elapsed = self.started_at.elapsed();
        if elapsed >= SQL_WRITER_HOLD_WARN {
            log::warn!(
                "SQL transaction {outcome} after holding the writer for {:.3} seconds",
                elapsed.as_secs_f64()
            );
        }
    }
}

pub(crate) struct SqliteWriter {
    next_id: AtomicU32,
    session: Arc<RwLock<SqlTransactionSession>>,
    writer: Arc<Mutex<()>>,
}

#[derive(Default)]
struct SqlTransactionSession {
    id: Option<String>,
    transactions: HashMap<u32, Arc<SqlTransaction>>,
}

impl Default for SqliteWriter {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            session: Arc::new(RwLock::new(SqlTransactionSession::default())),
            writer: Arc::new(Mutex::new(())),
        }
    }
}

impl SqliteWriter {
    async fn start_session(&self, session_id: String) -> Result<(), String> {
        let mut session = self.session.write().await;
        if session.id.as_deref() == Some(&session_id) {
            return Ok(());
        }
        session.id = Some(session_id);
        let abandoned = session
            .transactions
            .drain()
            .map(|(_, transaction)| transaction);

        let mut abandoned_count = 0;
        let mut errors = Vec::new();
        for transaction in abandoned {
            abandoned_count += 1;
            match timeout(SQL_TRANSACTION_ROLLBACK_TIMEOUT, transaction.rollback()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error),
                Err(_) => {
                    errors.push("Timed out rolling back an abandoned SQL transaction".to_owned())
                }
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        if abandoned_count > 0 {
            log::warn!(
                "Rolled back {abandoned_count} SQL transaction(s) abandoned by the previous frontend session"
            );
        }
        Ok(())
    }

    async fn begin(&self, pool: &SqlitePool, session_id: &str) -> Result<u32, String> {
        {
            let session = self.session.read().await;
            if session.id.as_deref() != Some(session_id) {
                return Err("SQL transaction session is no longer active".to_owned());
            }
        }

        let wait_started_at = Instant::now();
        let writer = Arc::clone(&self.writer).lock_owned().await;
        Self::log_writer_wait("transaction", wait_started_at.elapsed());
        let transaction = Arc::new(SqlTransaction::begin(pool, writer).await?);
        let mut session = self.session.write().await;
        if session.id.as_deref() != Some(session_id) {
            transaction.rollback().await?;
            return Err("SQL transaction session is no longer active".to_owned());
        }
        loop {
            let transaction_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            if let std::collections::hash_map::Entry::Vacant(entry) =
                session.transactions.entry(transaction_id)
            {
                entry.insert(transaction);
                drop(session);
                tauri::async_runtime::spawn(Self::expire_transaction(
                    Arc::clone(&self.session),
                    session_id.to_owned(),
                    transaction_id,
                ));
                return Ok(transaction_id);
            }
        }
    }

    async fn execute_write(
        &self,
        pool: &SqlitePool,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<QueryResult, String> {
        let wait_started_at = Instant::now();
        let _writer = self.writer.lock().await;
        Self::log_writer_wait("statement", wait_started_at.elapsed());
        let started_at = Instant::now();
        let result = execute_on(pool, query, values).await;
        Self::log_writer_hold("statement", started_at.elapsed());
        result
    }

    async fn select_write(
        &self,
        pool: &SqlitePool,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<Vec<JsonValue>, String> {
        let wait_started_at = Instant::now();
        let _writer = self.writer.lock().await;
        Self::log_writer_wait("statement returning rows", wait_started_at.elapsed());
        let started_at = Instant::now();
        let result = select_on(pool, query, values).await;
        Self::log_writer_hold("statement returning rows", started_at.elapsed());
        result
    }

    fn log_writer_wait(operation: &str, elapsed: Duration) {
        if elapsed >= SQL_WRITER_WAIT_WARN {
            log::warn!(
                "SQL {operation} waited {:.3} seconds for the database writer",
                elapsed.as_secs_f64()
            );
        }
    }

    fn log_writer_hold(operation: &str, elapsed: Duration) {
        if elapsed >= SQL_WRITER_HOLD_WARN {
            log::warn!(
                "SQL {operation} held the database writer for {:.3} seconds",
                elapsed.as_secs_f64()
            );
        }
    }

    async fn execute(
        &self,
        session_id: &str,
        transaction_id: u32,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<QueryResult, String> {
        let transaction = self.get(session_id, transaction_id).await?;
        match timeout(
            SQL_TRANSACTION_STATEMENT_TIMEOUT,
            transaction.execute(query, values),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(self
                .abort_timed_out(session_id, transaction_id, "execute")
                .await),
        }
    }

    async fn select(
        &self,
        session_id: &str,
        transaction_id: u32,
        query: &str,
        values: Vec<JsonValue>,
    ) -> Result<Vec<JsonValue>, String> {
        let transaction = self.get(session_id, transaction_id).await?;
        match timeout(
            SQL_TRANSACTION_STATEMENT_TIMEOUT,
            transaction.select(query, values),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(self
                .abort_timed_out(session_id, transaction_id, "select")
                .await),
        }
    }

    async fn commit(&self, session_id: &str, transaction_id: u32) -> Result<(), String> {
        let mut session = self.session.write().await;
        let transaction = Self::remove(&mut session, session_id, transaction_id)?;
        transaction.commit().await
    }

    async fn rollback(&self, session_id: &str, transaction_id: u32) -> Result<(), String> {
        let mut session = self.session.write().await;
        if session.id.as_deref() != Some(session_id) {
            return Err("SQL transaction session is no longer active".to_owned());
        }
        let Some(transaction) = session.transactions.remove(&transaction_id) else {
            return Ok(());
        };
        transaction.rollback().await
    }

    async fn abort_timed_out(
        &self,
        session_id: &str,
        transaction_id: u32,
        operation: &str,
    ) -> String {
        let rollback = timeout(
            SQL_TRANSACTION_ROLLBACK_TIMEOUT,
            self.rollback(session_id, transaction_id),
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

    async fn get(
        &self,
        session_id: &str,
        transaction_id: u32,
    ) -> Result<Arc<SqlTransaction>, String> {
        let session = self.session.read().await;
        if session.id.as_deref() != Some(session_id) {
            return Err("SQL transaction session is no longer active".to_owned());
        }
        session
            .transactions
            .get(&transaction_id)
            .cloned()
            .ok_or_else(|| format!("SQL transaction {transaction_id} is not active"))
    }

    fn remove(
        session: &mut SqlTransactionSession,
        session_id: &str,
        transaction_id: u32,
    ) -> Result<Arc<SqlTransaction>, String> {
        if session.id.as_deref() != Some(session_id) {
            return Err("SQL transaction session is no longer active".to_owned());
        }
        session
            .transactions
            .remove(&transaction_id)
            .ok_or_else(|| format!("SQL transaction {transaction_id} is not active"))
    }

    async fn expire_transaction(
        session: Arc<RwLock<SqlTransactionSession>>,
        session_id: String,
        transaction_id: u32,
    ) {
        tokio::time::sleep(SQL_TRANSACTION_LIFETIME_TIMEOUT).await;
        let mut session = session.write().await;
        if session.id.as_deref() != Some(&session_id) {
            return;
        }
        let Some(transaction) = session.transactions.remove(&transaction_id) else {
            return;
        };

        match timeout(SQL_TRANSACTION_ROLLBACK_TIMEOUT, transaction.rollback()).await {
            Ok(Ok(())) => log::warn!(
                "Rolled back SQL transaction {transaction_id} after it exceeded the maximum lifetime"
            ),
            Ok(Err(error)) => {
                log::error!("Failed to roll back expired SQL transaction {transaction_id}: {error}")
            }
            Err(_) => {
                log::error!("Timed out rolling back expired SQL transaction {transaction_id}")
            }
        }
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
    writer: State<'_, SqliteWriter>,
    db: String,
    session_id: String,
) -> Result<u32, String> {
    let pool = sqlite_pool(&db_instances, &db).await?;
    writer.begin(&pool, &session_id).await
}

#[tauri::command]
pub(crate) async fn sql_execute_write(
    db_instances: State<'_, DbInstances>,
    writer: State<'_, SqliteWriter>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    let pool = sqlite_pool(&db_instances, &db).await?;
    writer.execute_write(&pool, &query, values).await
}

#[tauri::command]
pub(crate) async fn sql_select_write(
    db_instances: State<'_, DbInstances>,
    writer: State<'_, SqliteWriter>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    let pool = sqlite_pool(&db_instances, &db).await?;
    writer.select_write(&pool, &query, values).await
}

#[tauri::command]
pub(crate) async fn sql_start_transaction_session(
    writer: State<'_, SqliteWriter>,
    session_id: String,
) -> Result<(), String> {
    writer.start_session(session_id).await
}

#[tauri::command]
pub(crate) async fn sql_execute(
    writer: State<'_, SqliteWriter>,
    session_id: String,
    transaction_id: u32,
    query: String,
    values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    writer
        .execute(&session_id, transaction_id, &query, values)
        .await
}

#[tauri::command]
pub(crate) async fn sql_select(
    writer: State<'_, SqliteWriter>,
    session_id: String,
    transaction_id: u32,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    writer
        .select(&session_id, transaction_id, &query, values)
        .await
}

#[tauri::command]
pub(crate) async fn sql_commit_transaction(
    writer: State<'_, SqliteWriter>,
    session_id: String,
    transaction_id: u32,
) -> Result<(), String> {
    writer.commit(&session_id, transaction_id).await
}

#[tauri::command]
pub(crate) async fn sql_rollback_transaction(
    writer: State<'_, SqliteWriter>,
    session_id: String,
    transaction_id: u32,
) -> Result<(), String> {
    writer.rollback(&session_id, transaction_id).await
}

async fn sqlite_pool(db_instances: &DbInstances, db: &str) -> Result<SqlitePool, String> {
    let instances = db_instances.0.read().await;
    let pool = instances
        .get(db)
        .ok_or_else(|| format!("Database not loaded: {db}"))?;
    #[allow(unreachable_patterns)]
    match pool {
        DbPool::Sqlite(pool) => Ok(pool.clone()),
        _ => Err("SQL writes are only supported for SQLite".to_owned()),
    }
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
    use super::{SqlTransaction, SqliteWriter, execute_on, select_on};
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::Mutex;

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

            let writer = Arc::new(Mutex::new(())).lock_owned().await;
            let transaction = SqlTransaction::begin(&pool, writer).await.unwrap();
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

            let transactions = SqliteWriter::default();
            transactions
                .start_session("first".to_owned())
                .await
                .unwrap();
            let transaction_id = transactions.begin(&pool, "first").await.unwrap();
            transactions
                .execute(
                    "first",
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(9), json!("pending")],
                )
                .await
                .unwrap();

            let pending = transactions
                .select(
                    "first",
                    transaction_id,
                    "SELECT id, state FROM recovery_units",
                    vec![],
                )
                .await
                .unwrap();
            assert_eq!(pending, vec![json!({ "id": 9, "state": "pending" })]);

            transactions
                .rollback("first", transaction_id)
                .await
                .unwrap();

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }

    #[test]
    fn ordinary_writes_wait_for_an_active_transaction_writer() {
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

            let transactions = Arc::new(SqliteWriter::default());
            transactions
                .start_session("first".to_owned())
                .await
                .unwrap();
            let transaction_id = transactions.begin(&pool, "first").await.unwrap();
            transactions
                .execute(
                    "first",
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(14), json!("transaction")],
                )
                .await
                .unwrap();

            let write_finished = Arc::new(AtomicBool::new(false));
            let pending_write = {
                let pool = pool.clone();
                let transactions = Arc::clone(&transactions);
                let write_finished = Arc::clone(&write_finished);
                tauri::async_runtime::spawn(async move {
                    let result = transactions
                        .execute_write(
                            &pool,
                            "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                            vec![json!(15), json!("ordinary")],
                        )
                        .await;
                    write_finished.store(true, Ordering::SeqCst);
                    result
                })
            };
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(5)).await;
            assert!(!write_finished.load(Ordering::SeqCst));

            transactions.commit("first", transaction_id).await.unwrap();
            pending_write.await.unwrap().unwrap();

            let durable = select_on(
                &pool,
                "SELECT id, state FROM recovery_units ORDER BY id",
                vec![],
            )
            .await
            .unwrap();
            assert_eq!(
                durable,
                vec![
                    json!({ "id": 14, "state": "transaction" }),
                    json!({ "id": 15, "state": "ordinary" }),
                ]
            );
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

            let transactions = Arc::new(SqliteWriter::default());
            transactions
                .start_session("first".to_owned())
                .await
                .unwrap();
            let transaction_id = transactions.begin(&pool, "first").await.unwrap();
            transactions
                .execute(
                    "first",
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(10), json!("pending")],
                )
                .await
                .unwrap();

            let transaction = transactions.get("first", transaction_id).await.unwrap();
            let transaction_guard = transaction.transaction.lock().await;
            let pending_select = {
                let transactions = Arc::clone(&transactions);
                tauri::async_runtime::spawn(async move {
                    transactions
                        .select(
                            "first",
                            transaction_id,
                            "SELECT id FROM recovery_units",
                            vec![],
                        )
                        .await
                })
            };
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
            drop(transaction_guard);

            let error = pending_select.await.unwrap().unwrap_err();
            assert!(error.contains("timed out"));
            assert!(transactions.get("first", transaction_id).await.is_err());

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }

    #[test]
    fn replacing_frontend_session_rolls_back_abandoned_transaction() {
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

            let transactions = SqliteWriter::default();
            transactions
                .start_session("old-page".to_owned())
                .await
                .unwrap();
            let abandoned_id = transactions.begin(&pool, "old-page").await.unwrap();
            transactions
                .execute(
                    "old-page",
                    abandoned_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(11), json!("abandoned")],
                )
                .await
                .unwrap();

            transactions
                .start_session("new-page".to_owned())
                .await
                .unwrap();
            assert!(transactions.get("old-page", abandoned_id).await.is_err());

            let replacement_id = transactions.begin(&pool, "new-page").await.unwrap();
            transactions
                .execute(
                    "new-page",
                    replacement_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(12), json!("replacement")],
                )
                .await
                .unwrap();
            transactions
                .commit("new-page", replacement_id)
                .await
                .unwrap();

            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert_eq!(durable, vec![json!({ "id": 12, "state": "replacement" })]);
        });
    }

    #[test]
    fn expired_transaction_is_rolled_back() {
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

            let transactions = SqliteWriter::default();
            transactions
                .start_session("first".to_owned())
                .await
                .unwrap();
            let transaction_id = transactions.begin(&pool, "first").await.unwrap();
            transactions
                .execute(
                    "first",
                    transaction_id,
                    "INSERT INTO recovery_units (id, state) VALUES (?, ?)",
                    vec![json!(13), json!("idle")],
                )
                .await
                .unwrap();

            tokio::time::sleep(Duration::from_millis(120)).await;
            assert!(transactions.get("first", transaction_id).await.is_err());
            let durable = select_on(&pool, "SELECT id, state FROM recovery_units", vec![])
                .await
                .unwrap();
            assert!(durable.is_empty());
        });
    }
}
