/**
 * Verify and manage skills-lock.json and machine-local skills-lock.local.json.
 *
 * The lock's `computedHash` is a source snapshot hash produced during download;
 * it is not reproducible from the installed copy. This module therefore checks
 * inventory and skill identity, while content changes are reviewed via git diff.
 */
import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { readIfExists, writeFileAtomic } from './task/store.js';
import { SKILLS_DIR } from './workspace-config.js';

export const DEFAULT_LOCK_FILE = 'skills-lock.json';
export const LOCAL_LOCK_FILE = 'skills-lock.local.json';

/**
 * @typedef {{ source?: string, sourceType?: string, skillPath?: string, computedHash?: string, [key: string]: unknown }} SkillLockEntry
 * @typedef {{ version?: number, skills: Record<string, SkillLockEntry> }} SkillsLock
 * @typedef {{ name: string, ok: boolean, missing?: boolean, nameMismatch?: boolean, actualName?: string | null }} SkillCheckResult
 */

/**
 * @param {string} lockPath
 * @returns {Promise<SkillsLock>}
 */
export async function readSkillsLock(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const skills = lock?.skills;

  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new Error(`Invalid skills lock: ${lockPath}`);
  }

  return lock;
}

/**
 * Read a skills lock file if it exists; return `null` when missing.
 * Validation and non-ENOENT filesystem errors are rethrown.
 *
 * @param {string} lockPath
 * @returns {Promise<SkillsLock | null>}
 */
export async function readOptionalSkillsLock(lockPath) {
  try {
    return await readSkillsLock(lockPath);
  } catch (error) {
    const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Read the tracked lock merged with the optional machine-local lock.
 * Entries in the tracked `skills-lock.json` take precedence over local entries.
 *
 * @param {{ lockPath: string, localLockPath?: string | null }} options
 * @returns {Promise<SkillsLock>}
 */
export async function readMergedSkillsLock({
  lockPath,
  localLockPath = path.join(path.dirname(lockPath), LOCAL_LOCK_FILE),
}) {
  const base = await readSkillsLock(lockPath);
  if (!localLockPath) return base;
  const local = await readOptionalSkillsLock(localLockPath);
  if (!local) return base;
  /** @type {Record<string, SkillLockEntry>} */
  const skills = { ...base.skills };
  for (const [name, entry] of Object.entries(local.skills)) {
    if (!Object.hasOwn(skills, name)) {
      skills[name] = entry;
    }
  }
  return {
    version: base.version ?? local.version ?? 2,
    skills,
  };
}

/**
 * Write a skills lock atomically with skills sorted by key.
 *
 * @param {string} lockPath
 * @param {SkillsLock} lock
 */
export function writeSkillsLock(lockPath, lock) {
  /** @type {Record<string, SkillLockEntry>} */
  const sortedSkills = {};
  for (const name of Object.keys(lock.skills).sort()) {
    sortedSkills[name] = lock.skills[name];
  }
  const payload =
    JSON.stringify(
      { version: lock.version ?? 2, skills: sortedSkills },
      null,
      2
    ) + '\n';
  writeFileAtomic(lockPath, payload);
}

/**
 * Restore a file to a previously captured snapshot (or remove it if it did not
 * exist before). No-op when the file is already unchanged.
 *
 * @param {string} filePath
 * @param {string | null} originalRaw
 */
export function restoreFileSnapshot(filePath, originalRaw) {
  if (originalRaw === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
      if (code !== 'ENOENT') throw error;
    }
    return;
  }
  const current = readIfExists(filePath);
  if (current !== originalRaw) {
    writeFileAtomic(filePath, originalRaw);
  }
}

/**
 * Read the `name` field from a SKILL.md frontmatter block.
 *
 * @param {string} skillPath
 * @returns {Promise<string | null>}
 */
async function readSkillName(skillPath) {
  const content = await readFile(skillPath, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;

  const nameLine = frontmatter[1].match(/^name:\s*(.+)$/m);
  if (!nameLine) return null;

  return nameLine[1].trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Verify every entry in skills-lock.json (and skills-lock.local.json if
 * present) has a .agents/skills/<name>/SKILL.md whose frontmatter name matches
 * the lock key.
 *
 * @param {{ rootDir: string, lockPath: string, localLockPath?: string | null }} options
 * @returns {Promise<SkillCheckResult[]>}
 */
export async function checkSkills({ rootDir, lockPath, localLockPath }) {
  const lock = await readMergedSkillsLock({ lockPath, localLockPath });
  /** @type {SkillCheckResult[]} */
  const results = [];

  for (const name of Object.keys(lock.skills)) {
    const skillPath = path.join(rootDir, SKILLS_DIR, name, 'SKILL.md');

    try {
      const actualName = await readSkillName(skillPath);
      if (actualName === name) {
        results.push({ name, ok: true, actualName });
      } else {
        results.push({ name, ok: false, nameMismatch: true, actualName });
      }
    } catch (error) {
      const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
      if (code !== 'ENOENT') throw error;
      results.push({ name, ok: false, missing: true, actualName: null });
    }
  }

  return results;
}
