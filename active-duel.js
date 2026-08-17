(function () {
    const KEY = 'waater_active_duel';
    let barEl = null;
    let tickInterval = null;

    function getActiveDuel() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return null;
            const duel = JSON.parse(raw);
            const elapsed = (Date.now() - duel.startTime) / 1000;
            if (elapsed > duel.duration) {
                localStorage.removeItem(KEY);
                return null;
            }
            return duel;
        } catch (e) {
            return null;
        }
    }

    window.setActiveDuel = function (duel) {
        localStorage.setItem(KEY, JSON.stringify({
            matchId: duel.matchId,
            thesis: duel.thesis,
            imageUrl: duel.imageUrl || null,
            startTime: duel.startTime || Date.now(),
            duration: duel.duration || 180
        }));
        renderBar();
    };

    window.clearActiveDuel = function () {
        localStorage.removeItem(KEY);
        removeBar();
    };

    function removeBar() {
        if (barEl) { barEl.remove(); barEl = null; }
        clearInterval(tickInterval);
        document.body.style.paddingTop = '';
    }

    function renderBar() {
        const duel = getActiveDuel();
        removeBar();
        if (!duel) return;

        barEl = document.createElement('div');
        barEl.id = 'active-duel-bar';
        barEl.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 5000;
            background: #111827; border-bottom: 1px solid #1f2937;
            display: flex; align-items: center; gap: 12px;
            padding: 10px 20px; cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,.3);
        `;
        barEl.innerHTML = `
            ${duel.imageUrl ? `<img src="${duel.imageUrl}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;">` : ''}
            <span style="color:#fff;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">⚔️ ${duel.thesis}</span>
            <span id="active-duel-timer" style="color:#3b82f6;font-weight:700;flex-shrink:0;"></span>
        `;
        barEl.addEventListener('click', () => {
            if (!window.location.pathname.startsWith('/Create')) {
                window.location.href = '/Create';
            }
        });

        document.body.prepend(barEl);
        document.body.style.paddingTop = barEl.offsetHeight + 'px';

        tickInterval = setInterval(() => {
            const d = getActiveDuel();
            if (!d) { removeBar(); return; }
            const remaining = Math.max(0, Math.floor(d.duration - (Date.now() - d.startTime) / 1000));
            const m = String(Math.floor(remaining / 60)).padStart(2, '0');
            const s = String(remaining % 60).padStart(2, '0');
            const el = document.getElementById('active-duel-timer');
            if (el) el.textContent = `${m}:${s}`;
            if (remaining <= 0) window.clearActiveDuel();
        }, 1000);
    }

    document.addEventListener('DOMContentLoaded', renderBar);
})();