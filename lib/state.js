import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readState(directory, file, missing) {
  try {
    return JSON.parse(await readFile(join(directory, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw error;
  }
}

export async function writeState(directory, file, value) {
  const target = join(directory, file);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o640, flag: 'wx' });
  await rename(temp, target);
}
