import 'server-only';
import { AppError } from '../lib/errors.ts';

// A future adapter must resolve opaque keys inside private storage after authorization.
// No filesystem implementation, upload handler or public URL is available in stage 01.
export interface PrivateStorage {
  read(key: string): Promise<Uint8Array>;
  write(key: string, data: Uint8Array): Promise<void>;
}
export const privateStorage: PrivateStorage = {
  async read() { throw new AppError('UNAVAILABLE'); },
  async write() { throw new AppError('UNAVAILABLE'); },
};
