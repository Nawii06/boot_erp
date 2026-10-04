export function requiredUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export function assertLocalDatabase(connectionString, database, suffix) {
  const url = new URL(connectionString);
  if (process.env.NODE_ENV === 'production' || url.protocol !== 'postgresql:' ||
      !['127.0.0.1','localhost'].includes(url.hostname) || url.port !== '55432' ||
      url.pathname !== `/${database}` || decodeURIComponent(url.username) !== `${database}_${suffix}` || url.search) {
    throw new Error('Only the isolated local development/test database is allowed');
  }
  return connectionString;
}
