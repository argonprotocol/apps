import { db } from './Database';

export interface IUserRecordInput {
  name: string;
  inviteCode: string;
  vaultId: number;
  couponTxId: number;
  couponPublicKey: string;
  couponPrivateKey: string;
  couponMaxSatoshis: bigint;
  couponExpirationFrame: number;
  couponExpiresAt: Date;
  firstClickedAt: Date | null;
  lastClickedAt: Date | null;
  registeredAppAt: Date | null;
  lockedBitcoinAt: Date | null;
  appLastSeenAt: Date | null;
}

export interface IUserRecord extends IUserRecordInput {
  id: number;
  createdAt: Date | null;
}

const insertUserStmt = db.prepare(`
  INSERT INTO TreasuryInvites (
    name,
    inviteCode,
    vaultId,
    couponTxId,
    couponPublicKey,
    couponPrivateKey,
    couponMaxSatoshis,
    couponExpirationFrame,
    couponExpiresAt,
    firstClickedAt,
    lastClickedAt,
    registeredAppAt,
    lockedBitcoinAt,
    appLastSeenAt
  )
  VALUES (
    $name,
    $inviteCode,
    $vaultId,
    $couponTxId,
    $couponPublicKey,
    $couponPrivateKey,
    $couponMaxSatoshis,
    $couponExpirationFrame,
    $couponExpiresAt,
    $firstClickedAt,
    $lastClickedAt,
    $registeredAppAt,
    $lockedBitcoinAt,
    $appLastSeenAt
  )
  RETURNING
    id,
    name,
    inviteCode,
    vaultId,
    couponTxId,
    couponPublicKey,
    couponPrivateKey,
    couponMaxSatoshis,
    couponExpirationFrame,
    couponExpiresAt,
    firstClickedAt,
    lastClickedAt,
    registeredAppAt,
    lockedBitcoinAt,
    appLastSeenAt,
    createdAt
`);

const selectUserColumns = `
  id,
  vaultId,
  name,
  inviteCode,
  couponTxId,
  couponPublicKey,
  couponPrivateKey,
  couponMaxSatoshis,
  couponExpirationFrame,
  couponExpiresAt,
  firstClickedAt,
  lastClickedAt,
  registeredAppAt,
  lockedBitcoinAt,
  appLastSeenAt,
  createdAt
`;

const listInvitesStmt = db.prepare(`
  SELECT
    ${selectUserColumns}
  FROM TreasuryInvites
  WHERE registeredAppAt IS NULL OR registeredAppAt >= $registeredAppAtCutoff
  ORDER BY createdAt DESC, id DESC
`);

const listMembersStmt = db.prepare(`
  SELECT
    ${selectUserColumns}
  FROM TreasuryInvites
  WHERE registeredAppAt IS NOT NULL
  ORDER BY createdAt DESC, id DESC
`);

const getInviteByCodeStmt = db.prepare(`
  SELECT
    ${selectUserColumns}
  FROM TreasuryInvites
  WHERE inviteCode = $inviteCode
  LIMIT 1
`);

const setClickedAtStmt = db.prepare(`
  UPDATE TreasuryInvites
  SET
    firstClickedAt = COALESCE(firstClickedAt, $clickedAt),
    lastClickedAt = $clickedAt
  WHERE inviteCode = $inviteCode
  RETURNING
    ${selectUserColumns}
`);

const setRegisteredAppAtStmt = db.prepare(`
  UPDATE TreasuryInvites
  SET
    registeredAppAt = COALESCE(registeredAppAt, $registeredAppAt),
    appLastSeenAt = $registeredAppAt
  WHERE inviteCode = $inviteCode
  RETURNING
    ${selectUserColumns}
`);

function toSqlValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

export class TreasuryUserTable {
  public static insert(user: IUserRecordInput): IUserRecord {
    const record = insertUserStmt.get({
      $name: user.name,
      $inviteCode: toSqlValue(user.inviteCode),
      $vaultId: toSqlValue(user.vaultId),
      $couponTxId: toSqlValue(user.couponTxId),
      $couponPublicKey: user.couponPublicKey,
      $couponPrivateKey: toSqlValue(user.couponPrivateKey),
      $couponMaxSatoshis: toSqlValue(user.couponMaxSatoshis),
      $couponExpirationFrame: toSqlValue(user.couponExpirationFrame),
      $couponExpiresAt: toSqlValue(user.couponExpiresAt),
      $firstClickedAt: toSqlValue(user.firstClickedAt),
      $lastClickedAt: toSqlValue(user.lastClickedAt),
      $registeredAppAt: toSqlValue(user.registeredAppAt),
      $lockedBitcoinAt: toSqlValue(user.lockedBitcoinAt),
      $appLastSeenAt: toSqlValue(user.appLastSeenAt),
    });
    return this.mapRecord(record as Record<string, unknown>);
  }

  public static fetchInvites(): IUserRecord[] {
    const registeredAppAtCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const records = listInvitesStmt.all({
      $registeredAppAtCutoff: registeredAppAtCutoff,
    }) as Record<string, unknown>[];
    return records.map(record => this.mapRecord(record));
  }

  public static fetchMembers(): IUserRecord[] {
    const records = listMembersStmt.all() as Record<string, unknown>[];
    return records.map(record => this.mapRecord(record));
  }

  public static fetchInviteByCode(code: string): IUserRecord | null {
    const record = getInviteByCodeStmt.get({
      $inviteCode: code,
    }) as Record<string, unknown> | undefined;

    if (!record) {
      return null;
    }

    return this.mapRecord(record);
  }

  public static setClickedAt(inviteCode: string, clickedAt = new Date()): IUserRecord | null {
    const record = setClickedAtStmt.get({
      $inviteCode: inviteCode,
      $clickedAt: toSqlValue(clickedAt),
    });
    return record ? this.mapRecord(record as Record<string, unknown>) : null;
  }

  public static setRegisteredAppAt(inviteCode: string, registeredAt = new Date()): IUserRecord | null {
    const record = setRegisteredAppAtStmt.get({
      $inviteCode: inviteCode,
      $registeredAppAt: toSqlValue(registeredAt),
    });
    return record ? this.mapRecord(record as Record<string, unknown>) : null;
  }

  private static mapRecord(record: Record<string, any>): IUserRecord {
    return {
      id: Number(record.id),
      name: String(record.name),
      inviteCode: record.inviteCode,
      vaultId: Number(record.vaultId),
      couponTxId: Number(record.couponTxId),
      couponPublicKey: String(record.couponPublicKey),
      couponPrivateKey: String(record.couponPrivateKey),
      couponMaxSatoshis: BigInt(record.couponMaxSatoshis),
      couponExpirationFrame: Number(record.couponExpirationFrame),
      couponExpiresAt: new Date(record.couponExpiresAt),
      firstClickedAt: record.firstClickedAt ? new Date(record.firstClickedAt) : null,
      lastClickedAt: record.lastClickedAt ? new Date(record.lastClickedAt) : null,
      registeredAppAt: record.registeredAppAt ? new Date(record.registeredAppAt) : null,
      lockedBitcoinAt: record.lockedBitcoinAt ? new Date(record.lockedBitcoinAt) : null,
      appLastSeenAt: record.appLastSeenAt ? new Date(record.appLastSeenAt) : null,
      createdAt: new Date(record.createdAt),
    };
  }
}
