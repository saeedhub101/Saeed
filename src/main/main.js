const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const TaskPlanner = require('./planner');
const SkillsMemory = require('./skills-memory');
const UIExplorer = require('./ui-explorer');

let mainWindow = null;

const skillsMemory = new SkillsMemory();
const uiExplorer = new UIExplorer();
const planner = new TaskPlanner(skillsMemory, uiExplorer);

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1250,
        height: 850,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/chat.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.handle('execute-task', async (event, { taskDescription, payload }) => {
    try {
        console.log(`[Saeed Core] Task: ${taskDescription}`);
        const plan = await planner.createPlan(taskDescription, payload);
        const executionResult = await planner.executePlan(plan, payload);

        if (executionResult.success) {
            return { 
                status: 'PENDING_APPROVAL', 
                message: 'تم استكشاف الحقول وتجهيز التنفيذ بكفاءة تامة. يجوز مراجعة البيانات أدناه للموافقة النهائية.',
                previewData: payload,
                plan: plan,
                fromCache: plan.fromCache || false
            };
        }
    } catch (error) {
        return { status: 'ERROR', message: error.message };
    }
});

ipcMain.handle('confirm-final-action', async (event, { approved, taskDetails, payload }) => {
    if (approved) {
        console.log('[Saeed Core] Approved. Saving skill to memory...');
        await skillsMemory.saveSkill({
            name: taskDetails.name || 'مهمة عامة',
            keywords: [taskDetails.keyword || 'تنفيذ', taskDetails.name || 'مهمة'],
            steps: taskDetails.steps || []
        });
        return { status: 'SUCCESS', message: 'تم تنفيذ المهمة وحفظ المهارة في الذاكرة الدائمة بنجاح!' };
    } else {
        return { status: 'CANCELLED', message: 'تم إلغاء المهمة بناءً على طلبك.' };
    }
});
