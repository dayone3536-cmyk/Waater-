(function () {

    function ensureContainer() {
        let container = document.getElementById('__notifyContainer');
        if (container) return container;

        const style = document.createElement('style');
        style.textContent = `
            #__notifyContainer{
                position:fixed;
                top:20px;
                right:20px;
                z-index:9999;
                display:flex;
                flex-direction:column;
                gap:10px;
                pointer-events:none;
            }

            .__notifyCard{
                display:flex;
                align-items:center;
                gap:14px;
                min-width:280px;
                max-width:360px;
                padding:14px 18px;
                border-radius:16px;
                background:rgba(21,25,36,.75);
                backdrop-filter:blur(16px);
                -webkit-backdrop-filter:blur(16px);
                border:1px solid rgba(255,255,255,.08);
                box-shadow:0 8px 32px rgba(0,0,0,.4);
                font-family:Inter,system-ui,sans-serif;
                color:white;
                opacity:0;
                transform:translateY(-16px) scale(.96);
                transition:opacity .35s ease, transform .35s ease;
                pointer-events:auto;
            }

            .__notifyCard.show{
                opacity:1;
                transform:translateY(0) scale(1);
            }

            .__notifyIcon{
                flex-shrink:0;
                width:38px;
                height:38px;
                border-radius:50%;
                display:flex;
                align-items:center;
                justify-content:center;
                background:linear-gradient(135deg, rgba(70,194,255,.25), rgba(109,93,252,.25));
                border:1px solid rgba(70,194,255,.3);
            }

            .__notifyIcon svg{
                width:18px;
                height:18px;
                stroke:#46c2ff;
            }

            .__notifyText{
                flex:1;
                min-width:0;
            }

            .__notifyTitle{
                font-size:.88rem;
                font-weight:700;
                margin-bottom:2px;
            }

            .__notifyBody{
                font-size:.78rem;
                color:#9ca3af;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
            }
        `;
        document.head.appendChild(style);

        container = document.createElement('div');
        container.id = '__notifyContainer';
        document.body.appendChild(container);
        return container;
    }

    function parseMessage(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.title) return parsed;
        } catch (e) {}
        // fallback for legacy plain-text notifications
        return { title: 'Notification', body: raw };
    }

    function showNotification({ title, body }) {
        return new Promise(resolve => {
            const container = ensureContainer();

            const card = document.createElement('div');
            card.className = '__notifyCard';
            card.innerHTML = `
                <div class="__notifyIcon">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 7h-9M14 17H5M17 3l3 4-3 4M7 21l-3-4 3-4"></path>
                    </svg>
                </div>
                <div class="__notifyText">
                    <div class="__notifyTitle">${escapeHtml(title)}</div>
                    <div class="__notifyBody">${escapeHtml(body)}</div>
                </div>
            `;

            container.appendChild(card);
            requestAnimationFrame(() => card.classList.add('show'));

            setTimeout(() => {
                card.classList.remove('show');
                setTimeout(() => {
                    card.remove();
                    resolve();
                }, 350);
            }, 4500);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    let isChecking = false;

    async function checkNotifications() {
        if (isChecking) return;
        isChecking = true;

        try {
            const res = await fetch('/notifications/pending');
            const notifications = await res.json();

            for (const n of notifications) {
                await showNotification(parseMessage(n.message));
                await fetch(`/notifications/${n.id}/ack`, { method: 'POST' });
            }
        } catch (e) {
            console.error('Notification check failed:', e);
        } finally {
            isChecking = false;
        }
    }

    // Check on initial load
    document.addEventListener('DOMContentLoaded', checkNotifications);

    // Check whenever the user comes back to this tab (this is the "coming online" moment for a web app)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkNotifications();
    });

    // Check when the browser regains network connectivity
    window.addEventListener('online', checkNotifications);

    // Check when the window regains focus (covers alt-tab / switching apps)
    window.addEventListener('focus', checkNotifications);

    // Background poll as a fallback, in case none of the above fire
    setInterval(checkNotifications, 30000);

})();

