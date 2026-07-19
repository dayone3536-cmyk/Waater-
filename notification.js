(function () {
    function ensureToastEl() {
        let el = document.getElementById('__globalNotifyToast');
        if (el) return el;

        const style = document.createElement('style');
        style.textContent = `
            #__globalNotifyToast{
                position:fixed;
                bottom:24px;
                left:50%;
                transform:translateX(-50%) translateY(20px);
                background:#1f2635;
                color:white;
                padding:14px 22px;
                border-radius:999px;
                font-size:.9rem;
                font-weight:600;
                font-family:Inter,system-ui,sans-serif;
                box-shadow:0 4px 20px rgba(0,0,0,.4);
                opacity:0;
                pointer-events:none;
                transition:opacity .3s, transform .3s;
                z-index:9999;
                max-width:90vw;
                text-align:center;
            }
            #__globalNotifyToast.show{
                opacity:1;
                transform:translateX(-50%) translateY(0);
            }
        `;
        document.head.appendChild(style);

        el = document.createElement('div');
        el.id = '__globalNotifyToast';
        document.body.appendChild(el);
        return el;
    }

    async function checkNotifications() {
        try {
            const res = await fetch('/notifications/pending');
            const notifications = await res.json();

            for (const n of notifications) {
                await showToast(n.message);
                await fetch(`/notifications/${n.id}/ack`, { method: 'POST' });
            }
        } catch (e) {
            console.error('Notification check failed:', e);
        }
    }

    function showToast(message) {
        return new Promise(resolve => {
            const el = ensureToastEl();
            el.textContent = message;
            el.classList.add('show');
            setTimeout(() => {
                el.classList.remove('show');
                setTimeout(resolve, 300);
            }, 4000);
        });
    }

    document.addEventListener('DOMContentLoaded', checkNotifications);
    setInterval(checkNotifications, 30000);
})();

