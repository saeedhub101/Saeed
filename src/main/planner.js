class TaskPlanner {
    constructor(memoryManager, uiExplorer) {
        this.memoryManager = memoryManager;
        this.uiExplorer = uiExplorer;
    }

    async createPlan(naturalLanguageRequest, contextData) {
        console.log(`[Planner] Analyzing: "${naturalLanguageRequest}"`);
        
        const existingSkill = await this.memoryManager.findSkill(naturalLanguageRequest);
        if (existingSkill) {
            console.log(`[Planner] Cache hit! Executing instantly via learned skill.`);
            return { fromCache: true, steps: existingSkill.steps, skillId: existingSkill.id };
        }

        const steps = [
            { id: 1, action: 'detect_fields', description: 'استكشاف الشاشة عند الطلب' },
            { id: 2, action: 'match_data', description: 'مطابقة البيانات مع الحقول' },
            { id: 3, action: 'fill_fields', description: 'إدخال البيانات وتفريغ الموارد' },
            { id: 4, action: 'validate_and_review', description: 'التحقق والمراجعة قبل الاعتماد' }
        ];

        return { fromCache: false, steps };
    }

    async executePlan(plan, pageContext) {
        try {
            const scanResult = await this.uiExplorer.scanActiveWindow();
            await this.uiExplorer.fillForm(pageContext);
            return { success: true, scanResult };
        } finally {
            if (this.uiExplorer && typeof this.uiExplorer.dispose === 'function') {
                this.uiExplorer.dispose();
            }
        }
    }
}

module.exports = TaskPlanner;
