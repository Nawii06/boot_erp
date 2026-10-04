import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
const root = resolve('.');
async function markdown(dir) {
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['.git','node_modules','.next'].includes(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) result.push(...await markdown(path));
    else if (e.name.endsWith('.md')) result.push(path);
  }
  return result;
}
const files = await markdown(root); let count = 0;
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (content.includes('\uFFFD')) throw new Error(`Invalid UTF-8 text: ${file}`);
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    await access(resolve(dirname(file), decodeURIComponent(target)));
    count++;
  }
}
console.log(`Markdown: ${files.length}; relative links: ${count}; missing targets: 0`);
