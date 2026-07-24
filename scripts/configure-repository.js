'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [owner, repository = 'offgrid'] = process.argv.slice(2);
if (!owner || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
  console.error('Uso: npm run configure -- SEU_USUARIO NOME_DO_REPOSITORIO');
  process.exit(1);
}

const packagePath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.publisher = owner.toLowerCase().replace(/[^a-z0-9-]/g, '-');
pkg.repository = { type: 'git', url: `https://github.com/${owner}/${repository}.git` };
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Configurado para https://github.com/${owner}/${repository}`);
