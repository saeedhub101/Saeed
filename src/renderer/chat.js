document.addEventListener('DOMContentLoaded', () => {
    const messagesContainer = document.getElementById('chat-messages');
    const taskInput = document.getElementById('task-input');
    const btnSend = document.getElementById('btn-send');
    const approvalBox = document.getElementById('approval-box');
    const approvalText = document.getElementById('approval-text');
    const btnApprove = document.getElementById('btn-approve');
    const btnCancel = document.getElementById('btn-cancel');

    let currentTaskData = null;

    function appendMessage(text, sender = 'system') {
        const div = document.createElement('div');
        div.className = `message ${sender}`;
        div.textContent = text;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    btnSend.addEventListener('click', async () => {
        const text = taskInput.value.trim();
        if (!text) return;

        appendMessage(text, 'user');
        taskInput.value = '';

        appendMessage('جاري تحليل الطلب، واستدعاء محرك الاستكشاف عند الطلب...', 'system');

        try {
            const response = await window.saeedAPI.executeTask(text, { clientName: 'مؤسسة الأعمال المتقدمة', recordId: 'REC-5542', taskQuery: text });
            if (response.status === 'PENDING_APPROVAL') {
                currentTaskData = response;
                let cacheNote = response.fromCache ? ' [تم العثور على مهارة سابقة وتنفيذها لحظياً ⚡]' : ' [استكشاف جديد وتفريغ الموارد بنجاح 🧠]';
                appendMessage(response.message + cacheNote, 'system');
                approvalText.textContent = `بيانات التنفيذ المستهدفة: ${JSON.stringify(response.previewData)}`;
                approvalBox.classList.remove('hidden');
            } else {
                appendMessage(response.message, 'system');
            }
        } catch (err) {
            appendMessage(`حدث خطأ أثناء التنفيذ: ${err.message}`, 'system');
        }
    });

    btnApprove.addEventListener('click', async () => {
        approvalBox.classList.add('hidden');
        appendMessage('جاري الاعتماد النهائي وحفظ المهارة في الذاكرة...', 'system');
        
        const res = await window.saeedAPI.confirmAction(true, { name: 'مهمة دورة الحياة المحسنة', keyword: 'تنفيذ', steps: currentTaskData.plan.steps }, currentTaskData.previewData);
        appendMessage(res.message, 'system');
    });

    btnCancel.addEventListener('click', async () => {
        approvalBox.classList.add('hidden');
        const res = await window.saeedAPI.confirmAction(false, {}, {});
        appendMessage(res.message, 'system');
    });
});
