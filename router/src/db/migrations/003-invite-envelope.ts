import type { ISqliteMigration } from '@argonprotocol/apps-core';

export const InviteEnvelopeMigration: ISqliteMigration = db => {
  const columns = db.prepare('PRAGMA table_info(UserInvites)').all() as { name: string }[];
  if (columns.some(column => column.name === 'inviteEnvelope')) {
    return;
  }

  db.exec(`
    ALTER TABLE UserInvites
    ADD COLUMN inviteEnvelope TEXT NOT NULL DEFAULT '';
  `);
};
