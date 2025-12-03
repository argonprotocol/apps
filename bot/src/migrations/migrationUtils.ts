import { promises as fs } from 'fs';
import { type ILastModifiedAt, JsonExt } from '@argonprotocol/apps-core';

export async function migrateDirectory<
  New extends Record<string, any> & ILastModifiedAt,
  AddedFields extends keyof New,
  RemovedFields extends Record<string, any>,
>(dir: string, processor: (key: string, data: Omit<New, AddedFields> & RemovedFields) => New): Promise<void> {
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    if (dirent.isFile()) {
      const filePath = `${dir}/${dirent.name}`;
      const data = JsonExt.parse(await fs.readFile(filePath, 'utf8'));
      const record = processor(dirent.name, data);
      await fs.writeFile(filePath, JsonExt.stringify(record, 2), 'utf8');
    }
  }
}
