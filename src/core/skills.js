const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('../config');

const SKILLS_DIR = path.join(DATA_ROOT, 'skills');
const CORE_SKILLS = ['core', 'tools', 'reasoning', 'methodology', 'code-style', 'domains'];

function loadSkill(name) {
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function loadAllSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''))
    .sort((a, b) => {
      const ai = CORE_SKILLS.indexOf(a);
      const bi = CORE_SKILLS.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
}

function buildSkillsPrompt({ include, extraSkills = [] } = {}) {
  const names = include || loadAllSkills();
  const parts = [];

  for (const name of names) {
    const content = loadSkill(name);
    if (content) parts.push(content);
  }

  for (const name of extraSkills) {
    if (!names.includes(name)) {
      const content = loadSkill(name);
      if (content) parts.push(content);
    }
  }

  return parts.join('\n\n');
}

function listSkills() {
  const names = loadAllSkills();
  return names.map(name => {
    const content = loadSkill(name);
    const firstLine = content?.split('\n').find(l => l.startsWith('# '));
    const title = firstLine ? firstLine.replace(/^#+\s*/, '') : name;
    return { name, title };
  });
}

module.exports = {
  SKILLS_DIR,
  buildSkillsPrompt,
  listSkills,
  loadAllSkills,
  loadSkill,
};
