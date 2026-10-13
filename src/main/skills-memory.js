const fs = require('fs');
const path = require('path');

class SkillsMemory {
    constructor(storagePath) {
        this.storagePath = storagePath || path.join(__dirname, '../../data/skills-registry.json');
        this.ensureStorage();
    }

    ensureStorage() {
        const dir = path.dirname(this.storagePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.storagePath)) {
            fs.writeFileSync(this.storagePath, JSON.stringify([], null, 2));
        }
    }

    async findSkill(queryText) {
        try {
            const raw = fs.readFileSync(this.storagePath, 'utf8');
            const skills = JSON.parse(raw);
            const normalizedQuery = queryText.toLowerCase().trim();

            for (const skill of skills) {
                const keywords = skill.keywords || [skill.keyword];
                for (const kw of keywords) {
                    if (kw && (normalizedQuery.includes(kw.toLowerCase()) || kw.toLowerCase().includes(normalizedQuery))) {
                        console.log(`[SkillsMemory] Semantic match found: ${skill.name}`);
                        return skill;
                    }
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async saveSkill(skillData) {
        try {
            const raw = fs.readFileSync(this.storagePath, 'utf8');
            const skills = JSON.parse(raw);
            skills.push({
                id: Date.now(),
                ...skillData,
                createdAt: new Date().toISOString()
            });
            fs.writeFileSync(this.storagePath, JSON.stringify(skills, null, 2));
            console.log(`[SkillsMemory] Skill saved: ${skillData.name}`);
        } catch (e) {
            console.error('[SkillsMemory] Save error:', e);
        }
    }
}

module.exports = SkillsMemory;
