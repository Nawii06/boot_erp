import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function localRoot() {
  const root = process.env.BOOT_ERP_LOCAL_ROOT
    ? resolve(process.env.BOOT_ERP_LOCAL_ROOT)
    : process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'boot_erp') : null;
  if (!root) throw new Error('Set BOOT_ERP_LOCAL_ROOT to a private directory outside the repository');
  const path = relative(fileURLToPath(new URL('../', import.meta.url)), root);
  if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Private configuration must be outside the repository');
  }
  return root;
}
