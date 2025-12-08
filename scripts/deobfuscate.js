#!/usr/bin/env node
/**
 * Simple formatter to make obfuscated JS more readable.
 * Usage:
 *   node scripts/deobfuscate.js <input.js> [output.js]
 *   node scripts/deobfuscate.js --all   (déobfusque tous les .js hors node_modules, deobf, scripts)
 * Par défaut écrit dans deobf/<chemin_relatif>.
 */

const fs = require('fs');
const path = require('path');
const prettier = require('prettier');

const EXCLUDE_DIRS = ['node_modules', 'deobf', 'scripts'];

function shouldSkip(filePath) {
  return EXCLUDE_DIRS.some((dir) => filePath.split(path.sep).includes(dir));
}

function listJsFiles(root) {
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (shouldSkip(full)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.js')) files.push(full);
    }
  }
  walk(root);
  return files;
}

async function main() {
  const arg1 = process.argv[2];
  const outputArg = process.argv[3];

  const targets = [];
  if (!arg1) {
    console.error('Usage: node scripts/deobfuscate.js <input.js> [output.js] | --all');
    process.exit(1);
  }

  if (arg1 === '--all') {
    targets.push(...listJsFiles(process.cwd()));
  } else {
    const inPath = path.resolve(arg1);
    if (!fs.existsSync(inPath)) {
      console.error(`Input file not found: ${inPath}`);
      process.exit(1);
    }
    targets.push(inPath);
  }

  const outRoot = path.join(process.cwd(), 'deobf');
  if (!fs.existsSync(outRoot)) fs.mkdirSync(outRoot, { recursive: true });

  for (const file of targets) {
    const code = fs.readFileSync(file, 'utf8');
    let formatted;
    try {
      formatted = await prettier.format(code, { parser: 'babel', printWidth: 100 });
    } catch (err) {
      console.error(`[${file}] Prettier failed, raw kept:`, err.message);
      formatted = code;
    }

    const rel = path.relative(process.cwd(), file);
    const outPath = outputArg
      ? path.resolve(outputArg)
      : path.join(outRoot, rel);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, formatted, 'utf8');
    console.log('✅ Deobfuscated ->', outPath);
  }
}

main();
