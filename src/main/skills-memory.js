const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class SkillsMemory {
    constructor(storagePath) {
        this.storagePath =
            storagePath ||
            path.join(
                app.getPath('userData'),
                'data',
                'skills-registry.json'
            );

        this.ensureStorage();
    }

    ensureStorage() {
        const dir = path.dirname(this.storagePath);

        fs.mkdirSync(dir, { recursive: true });

        if (!fs.existsSync(this.storagePath)) {
            fs.writeFileSync(
                this.storagePath,
                JSON.stringify([], null, 2),
                'utf8'
            );
        } else {
            const stats = fs.statSync(this.storagePath);

            if (!stats.isFile()) {
                throw new Error(
                    `Skills storage path is not a file: ${this.storagePath}`
                );
            }

            // Verify that the existing registry contains valid JSON.
            const content = fs.readFileSync(this.storagePath, 'utf8');
            const parsed = JSON.parse(content);

            if (!Array.isArray(parsed)) {
                throw new Error(
                    `Skills registry must contain a JSON array: ${this.storagePath}`
                );
            }
        }
    }

    async findSkill(queryText) {
        try {
            const raw = fs.readFileSync(this.storagePath, 'utf8');
            const skills = JSON.parse(raw);
            const normalizedQuery = String(queryText || '')
                .toLowerCase()
                .trim();

            if (!normalizedQuery) {
                return null;
            }

            for (const skill of skills) {
                const keywords = skill.keywords || [skill.keyword];

                for (const keyword of keywords) {
                    if (!keyword) continue;

                    const normalizedKeyword = String(keyword).toLowerCase();

                    if (
                        normalizedQuery.includes(normalizedKeyword) ||
                        normalizedKeyword.includes(normalizedQuery)
                    ) {
                        console.log(
                            `[SkillsMemory] Semantic match found: ${skill.name}`
                        );
                        return skill;
                    }
                }
            }

            return null;
        } catch (error) {
            console.error('[SkillsMemory] Read error:', error);
            return null;
        }
    }

    async saveSkill(skillData) {
        try {
            const raw = fs.readFileSync(this.storagePath, 'utf8');
            const skills = JSON.parse(raw);

            if (!Array.isArray(skills)) {
                throw new Error('Skills registry must contain a JSON array.');
            }

            skills.push({
                id: Date.now(),
                ...skillData,
                createdAt: new Date().toISOString()
            });

            const tempPath = `${this.storagePath}.tmp`;

            fs.writeFileSync(
                tempPath,
                JSON.stringify(skills, null, 2),
                'utf8'
            );

            fs.renameSync(tempPath, this.storagePath);

            console.log(
                `[SkillsMemory] Skill saved: ${skillData.name}`
            );

            return true;
        } catch (error) {
            console.error('[SkillsMemory] Save error:', error);
            return false;
        }
    }
}

module.exports = SkillsMemory;
