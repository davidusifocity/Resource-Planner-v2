/* CSU Resource Planner v5 */
/* Removed: skills matrix, categories, suggestions panel */
/* Added: CSV import, undo, confirm modal, date dropdown, working-day calculations */

const DAYS_PER_FTE = 5;
let workItems = [];
let resources = [];
let lastUpdated = null;
let currentPage = 'dashboard';
let currentFilters = { portfolioItem: 'all', resource: 'all' };
let currentAssignments = [];
let undoStack = []; // { type, data, description }
let toastTimer = null;

const sizeDefaults = { XS: 1, S: 3, M: 7, L: 15, XL: 30, XXL: 50 };

const avatarColors = [
    'linear-gradient(135deg,#1a7aab,#0d5a80)',
    'linear-gradient(135deg,#b32028,#801518)',
    'linear-gradient(135deg,#f5a623,#d48c15)',
    'linear-gradient(135deg,#22c997,#15a078)',
    'linear-gradient(135deg,#9b6dff,#7c4ddb)'
];
const portfolioItems = [
    { id: 'all', label: 'All' },
    { id: 'pstom', label: 'PSTOM' },
    { id: 'integration', label: 'Integration' },
    { id: 'strategic', label: 'Strategic' },
    { id: 'adhoc', label: 'Ad-hoc' }
];
const rolePrefixes = {
    'Director of Change': 'DC',
    'Head of Change': 'HC',
    'Head of PMO': 'HP',
    'Project Manager': 'PM',
    'Change Manager': 'CM',
    'Project Business Analyst': 'PBA',
    'Project Support Officer': 'PSO'
};
const validRoles = Object.keys(rolePrefixes);

// ─── Week System ─────────────────────────────────────────
function getWeekStartDates() {
    const dates = [];
    const today = new Date();
    const dow = today.getDay();
    const mon = new Date(today);
    mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    mon.setHours(0, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
        const ws = new Date(mon);
        ws.setDate(mon.getDate() + (i * 7));
        dates.push(ws);
    }
    return dates;
}
const weekStartDates = getWeekStartDates();
const weekLabels = weekStartDates.map(ws =>
    'W/C ' + ws.getDate() + ' ' + ws.toLocaleString('en-GB', { month: 'short' })
);

// ─── Storage ─────────────────────────────────────────────
function save() {
    lastUpdated = new Date().toISOString();
    localStorage.setItem('csu_v5', JSON.stringify({ workItems, resources, lastUpdated }));
    updateLastUpdated();
}

function load() {
    try {
        const d = JSON.parse(localStorage.getItem('csu_v5'));
        if (d) {
            workItems = validateWorkItems(d.workItems || []);
            resources = validateResources(d.resources || []);
            lastUpdated = d.lastUpdated;
            // Re-derive statuses on load based on current date
            workItems.forEach(w => {
                if (w.status !== 'blocked' && w.status !== 'complete') {
                    w.status = deriveStatus(w.startDate, w.duration);
                }
            });
        }
    } catch (e) {
        console.error('Failed to load data:', e);
        workItems = [];
        resources = [];
    }
    updateLastUpdated();
}

function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (lastUpdated) {
        const d = new Date(lastUpdated);
        el.textContent = 'Updated: ' + d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

// ─── Data Validation ─────────────────────────────────────
function validateWorkItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(w => {
        if (!w || typeof w !== 'object') return false;
        if (!w.id || typeof w.id !== 'string') return false;
        if (!w.title || typeof w.title !== 'string') return false;
        return true;
    }).map(w => ({
        id: String(w.id),
        title: String(w.title || '').substring(0, 200),
        portfolioItem: ['pstom', 'integration', 'strategic', 'adhoc'].includes(w.portfolioItem) ? w.portfolioItem : 'adhoc',
        size: ['XS', 'S', 'M', 'L', 'XL', 'XXL'].includes(w.size) ? w.size : 'M',
        duration: Math.max(1, Math.min(260, parseInt(w.duration) || 20)),
        startDate: isValidDateStr(w.startDate) ? w.startDate : '',
        status: ['upcoming', 'progress', 'blocked', 'complete'].includes(w.status) ? w.status : 'upcoming',
        assignedResources: Array.isArray(w.assignedResources) ? w.assignedResources.filter(r => typeof r === 'string') : []
    }));
}

function validateResources(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(r => {
        if (!r || typeof r !== 'object') return false;
        if (!r.id || typeof r.id !== 'string') return false;
        if (!r.name || typeof r.name !== 'string') return false;
        return true;
    }).map(r => ({
        id: String(r.id),
        name: String(r.name || '').substring(0, 100),
        role: validRoles.includes(r.role) ? r.role : '',
        totalFTE: Math.max(0.1, Math.min(1.0, parseFloat(r.totalFTE) || 1)),
        baselineCommitment: Math.max(0, Math.min(1.0, parseFloat(r.baselineCommitment) || 0))
    }));
}

function isValidDateStr(s) {
    if (!s || typeof s !== 'string') return false;
    const d = new Date(s + 'T00:00:00');
    return !isNaN(d.getTime());
}

// ─── Utilities ───────────────────────────────────────────
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function toast(msg, err, undoable) {
    const t = document.getElementById('toast');
    const msgEl = document.getElementById('toastMsg');
    const undoBtn = document.getElementById('toastUndo');
    msgEl.textContent = msg;
    t.className = 'toast show' + (err ? ' error' : '');
    undoBtn.style.display = undoable ? 'inline-block' : 'none';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.className = 'toast';
        // Clear undo stack after toast expires
        if (undoable) undoStack = [];
    }, 6000);
}

function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function getRes(id) { return resources.find(r => r.id === id); }

function heatClass(v) {
    if (v <= 0) return 'heat-available';
    if (v < 70) return 'heat-available';
    if (v < 85) return 'heat-ok';
    if (v < 95) return 'heat-tight';
    if (v <= 100) return 'heat-full';
    if (v <= 120) return 'heat-over';
    return 'heat-critical';
}

function getResourceColor(rid) {
    const idx = resources.findIndex(r => r.id === rid);
    return idx >= 0 ? avatarColors[idx % avatarColors.length] : avatarColors[0];
}

function getInitials(name) { return (name || '').split(' ').map(n => n[0]).join('').toUpperCase(); }

function toDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseDate(s) {
    if (!s) return null;
    const d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
}

// ─── Undo System ─────────────────────────────────────────
function pushUndo(type, data, description) {
    undoStack.push({ type, data: JSON.parse(JSON.stringify(data)), description });
    // Keep only last 5
    if (undoStack.length > 5) undoStack.shift();
}

function undoLastAction() {
    if (!undoStack.length) return;
    const action = undoStack.pop();
    if (action.type === 'deleteWorkItem') {
        workItems.push(action.data);
    } else if (action.type === 'deleteResource') {
        resources.push(action.data.resource);
        // Restore resource references in work items
        action.data.affectedItems.forEach(ai => {
            const wi = workItems.find(w => w.id === ai.id);
            if (wi) wi.assignedResources = ai.assignedResources;
        });
    }
    save();
    renderCurrentPage();
    toast('Undone: ' + action.description, false, false);
}

// ─── Confirm Modal ───────────────────────────────────────
function showConfirm(title, message, details, onConfirm) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const detailsEl = document.getElementById('confirmDetails');
    if (details) {
        detailsEl.innerHTML = details;
        detailsEl.style.display = 'block';
    } else {
        detailsEl.style.display = 'none';
    }
    const btn = document.getElementById('confirmBtn');
    btn.onclick = function () {
        closeModal('confirmModal');
        onConfirm();
    };
    document.getElementById('confirmModal').classList.add('active');
}

// ─── Auto ID ─────────────────────────────────────────────
function generateResourceId(role) {
    const prefix = rolePrefixes[role];
    if (!prefix) return null;
    const existing = resources.filter(r => r.id && r.id.startsWith(prefix)).map(r => parseInt(r.id.slice(prefix.length)) || 0);
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
    return prefix + String(next).padStart(2, '0');
}

function updateAutoId() {
    const role = document.getElementById('resRole').value;
    const display = document.getElementById('autoIdValue');
    if (role && rolePrefixes[role]) { display.textContent = generateResourceId(role); }
    else { display.textContent = '--'; }
}

// ─── Working Day Calculations ────────────────────────────
// Count working days (Mon-Fri) between two dates inclusive
function countWorkingDays(start, end) {
    let count = 0;
    const d = new Date(start);
    while (d <= end) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) count++;
        d.setDate(d.getDate() + 1);
    }
    return count;
}

// Add N working days to a date, returns the end date
function addWorkingDays(start, numDays) {
    const d = new Date(start);
    let added = 0;
    // The start day counts as day 1 if it's a working day
    while (added < numDays) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added++;
        if (added < numDays) d.setDate(d.getDate() + 1);
    }
    return d;
}

// Get the working-day end date for a work item
function getWorkItemEndDate(wi) {
    const start = parseDate(wi.startDate);
    if (!start) return null;
    const dur = wi.duration || 20;
    return addWorkingDays(start, dur);
}

// ─── Status Derivation ──────────────────────────────────
// Uses working days only. Start date = first working day, duration = number of working days.
function deriveStatus(startDate, duration) {
    if (!startDate) return 'upcoming';
    const start = parseDate(startDate);
    if (!start) return 'upcoming';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = addWorkingDays(start, duration || 20);
    if (today < start) return 'upcoming';
    if (today > end) return 'complete';
    return 'progress';
}

// ─── Estimation Model ────────────────────────────────────
function getEffortDays(size) { return sizeDefaults[size] || sizeDefaults.M; }

function getWiFTEPercent(wi) {
    const effort = getEffortDays(wi.size || 'M');
    const duration = wi.duration || 20;
    if (duration <= 0) return 0;
    return Math.round((effort / duration) * 100);
}

function getWiPerPersonFTE(wi) {
    const fteTotal = getWiFTEPercent(wi);
    const numRes = (wi.assignedResources || []).length;
    if (numRes <= 0) return fteTotal;
    return Math.round((fteTotal / numRes) * 10) / 10;
}

// ─── Determine which of the 4 rolling weeks a work item spans ─
function getWiActiveWeeks(wi) {
    const active = [false, false, false, false];
    const start = parseDate(wi.startDate);
    if (!start) {
        if (wi.status === 'progress' || wi.status === 'blocked') return [true, true, true, true];
        return [false, false, false, false];
    }
    const end = getWorkItemEndDate(wi);
    if (!end) return [false, false, false, false];

    for (let i = 0; i < 4; i++) {
        const weekStart = weekStartDates[i];
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 4); // Mon-Fri
        // Overlap: item start <= week end AND item end >= week start
        if (start <= weekEnd && end >= weekStart) {
            active[i] = true;
        }
    }
    return active;
}

// ─── Capacity Calculations ───────────────────────────────
function getResourceAvailableDays(rid) {
    const r = resources.find(x => x.id === rid);
    if (!r) return 0;
    const netFTE = (r.totalFTE || 1) - (r.baselineCommitment || 0);
    return Math.max(0, netFTE * DAYS_PER_FTE);
}

function calcResourceWeekPercent(rid) {
    const wp = [0, 0, 0, 0];
    workItems.forEach(wi => {
        if (wi.status === 'complete') return;
        if (!(wi.assignedResources || []).includes(rid)) return;
        const perPerson = getWiPerPersonFTE(wi);
        const activeWeeks = getWiActiveWeeks(wi);
        for (let i = 0; i < 4; i++) {
            if (activeWeeks[i]) wp[i] += perPerson;
        }
    });
    return wp.map(v => Math.round(v * 10) / 10);
}

function calcResourceWeekDays(rid) {
    const avail = getResourceAvailableDays(rid);
    const wp = calcResourceWeekPercent(rid);
    return wp.map(p => Math.round((p / 100) * avail * 10) / 10);
}

// ─── Date & Status Coordination ──────────────────────────
function onDateChange() {
    syncStatusFromDate();
}

function clearStartDate() {
    document.getElementById('wiStartDate').value = '';
    syncStatusFromDate();
}

function syncStatusFromDate() {
    const dateVal = document.getElementById('wiStartDate').value;
    const statusEl = document.getElementById('wiStatus');
    const currentStatus = statusEl.value;

    // Only auto-derive if NOT blocked or complete (user-controlled statuses)
    if (currentStatus === 'blocked' || currentStatus === 'complete') {
        updateStartDateHint();
        return;
    }

    if (dateVal) {
        const duration = parseInt(document.getElementById('wiDuration').value) || 20;
        const derived = deriveStatus(dateVal, duration);
        statusEl.value = derived;
    } else {
        // No date — default to upcoming
        if (currentStatus === 'progress') statusEl.value = 'upcoming';
    }
    updateStartDateHint();
}

function onStatusChange() {
    const status = document.getElementById('wiStatus').value;
    const dateVal = document.getElementById('wiStartDate').value;

    // If user sets "In Progress" but no date, suggest today
    if (status === 'progress' && !dateVal) {
        document.getElementById('wiStartDate').value = toDateStr(new Date());
    }
    // If user sets "Upcoming" and date is in the past, clear date
    if (status === 'upcoming' && dateVal) {
        const start = parseDate(dateVal);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (start && start <= today) {
            document.getElementById('wiStartDate').value = '';
        }
    }
    updateStartDateHint();
}

function updateStartDateHint() {
    const hint = document.getElementById('startDateHint');
    const dateVal = document.getElementById('wiStartDate').value;
    const status = document.getElementById('wiStatus').value;
    if (dateVal && status !== 'blocked' && status !== 'complete') {
        const duration = parseInt(document.getElementById('wiDuration').value) || 20;
        const derived = deriveStatus(dateVal, duration);
        const endDate = addWorkingDays(parseDate(dateVal), duration);
        const label = derived === 'progress' ? 'In Progress' : derived === 'complete' ? 'Complete' : 'Upcoming';
        hint.textContent = 'Auto-status: ' + label + ' · Ends ' + endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    } else if (dateVal) {
        hint.textContent = 'Date set (status manually controlled)';
    } else {
        hint.textContent = 'Click to select from calendar';
    }
}

// ─── Estimation UI ───────────────────────────────────────
function updateEstimation() {
    const size = document.getElementById('wiSize').value;
    const duration = parseInt(document.getElementById('wiDuration').value) || 20;
    const effortDays = getEffortDays(size);
    const ftePct = duration > 0 ? Math.round((effortDays / duration) * 100) : 0;

    document.getElementById('sizeHint').textContent = size + ' = ' + effortDays + ' effort days';
    document.getElementById('estEffortDays').textContent = effortDays;
    document.getElementById('estDuration').textContent = duration + ' days';
    document.getElementById('estFTE').textContent = ftePct + '%';
    updateFTEPerPerson();
}

function updateFTEPerPerson() {
    const size = document.getElementById('wiSize').value;
    const duration = parseInt(document.getElementById('wiDuration').value) || 20;
    const effortDays = getEffortDays(size);
    const ftePct = duration > 0 ? Math.round((effortDays / duration) * 100) : 0;
    const numRes = currentAssignments.filter(r => r).length;
    const el = document.getElementById('ftePerPerson');
    if (numRes === 0) {
        el.textContent = ftePct + '% (unassigned)';
    } else {
        const perPerson = Math.round((ftePct / numRes) * 10) / 10;
        el.textContent = perPerson + '% each (' + numRes + ' resource' + (numRes > 1 ? 's' : '') + ')';
    }
}

// ─── Resource Assignment Rows ────────────────────────────
function getAlreadyAssigned() {
    return currentAssignments.filter(r => r);
}

function renderAssignmentRows() {
    const c = document.getElementById('assignmentRows');
    if (currentAssignments.length === 0) {
        c.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:var(--fs-xs)">No resources assigned. Click "+ Add Resource".</div>';
        return;
    }
    const assigned = getAlreadyAssigned();
    c.innerHTML = currentAssignments.map((rid, i) => {
        // Filter out already-assigned resources from other rows (prevent duplicates)
        const availableResources = resources.filter(r => r.id === rid || !assigned.includes(r.id) || currentAssignments.indexOf(r.id) === i);
        return '<div class="assignment-row">' +
            '<select class="form-select" onchange="updateAssignment(' + i + ',this.value)">' +
            '<option value="">-- Select Resource --</option>' +
            availableResources.map(r => '<option value="' + esc(r.id) + '" ' + (rid === r.id ? 'selected' : '') + '>' + esc(r.name) + ' (' + esc(r.id) + ')</option>').join('') +
            '</select>' +
            '<div class="assignment-fte" id="assignFte' + i + '"></div>' +
            '<button class="delete-btn" onclick="removeAssignment(' + i + ')">×</button>' +
            '</div>';
    }).join('');
    updateAssignmentFTEs();
}

function addAssignmentRow() {
    currentAssignments.push('');
    renderAssignmentRows();
    updateFTEPerPerson();
}

function removeAssignment(i) {
    currentAssignments.splice(i, 1);
    renderAssignmentRows();
    updateFTEPerPerson();
}

function updateAssignment(i, val) {
    // Prevent duplicate: if this resource is already assigned in another slot, reject
    if (val && currentAssignments.includes(val) && currentAssignments.indexOf(val) !== i) {
        toast('Resource already assigned', true);
        // Reset the select back
        renderAssignmentRows();
        return;
    }
    currentAssignments[i] = val;
    updateAssignmentFTEs();
    updateFTEPerPerson();
    // Re-render to update available options in other dropdowns
    renderAssignmentRows();
}

function updateAssignmentFTEs() {
    const size = document.getElementById('wiSize').value;
    const duration = parseInt(document.getElementById('wiDuration').value) || 20;
    const effortDays = getEffortDays(size);
    const ftePct = duration > 0 ? Math.round((effortDays / duration) * 100) : 0;
    const valid = currentAssignments.filter(r => r).length;
    const perPerson = valid > 0 ? Math.round((ftePct / valid) * 10) / 10 : ftePct;
    currentAssignments.forEach((rid, i) => {
        const el = document.getElementById('assignFte' + i);
        if (el) el.textContent = rid ? perPerson + '%' : '--';
    });
}

// ─── Navigation ──────────────────────────────────────────
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    const navEl = document.querySelector('.nav-item[data-page="' + page + '"]');
    if (navEl) navEl.classList.add('active');
    renderCurrentPage();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
});

function renderCurrentPage() {
    if (currentPage === 'dashboard') renderDashboard();
    else if (currentPage === 'pipeline') renderPipelinePage();
    else if (currentPage === 'kanban') renderKanban();
    else if (currentPage === 'resources') renderResources();
    else if (currentPage === 'capacity') renderHeatmap('heatmapTableFull');
}

// ─── Stats ───────────────────────────────────────────────
function updateStats() {
    const inFlight = workItems.filter(w => w.status !== 'complete').length;
    document.getElementById('statWorkItems').textContent = inFlight;
    const totalDays = resources.reduce((s, r) => s + getResourceAvailableDays(r.id), 0);
    document.getElementById('statDays').textContent = Math.round(totalDays * 10) / 10;
    document.getElementById('sidebarDays').textContent = Math.round(totalDays * 10) / 10;
    let avgLoad = 0, riskCount = 0;
    if (resources.length) {
        const loads = resources.map(r => { const w = calcResourceWeekPercent(r.id); return w.reduce((a, b) => a + b, 0) / w.length; });
        avgLoad = Math.round(loads.reduce((a, b) => a + b, 0) / loads.length);
        riskCount = resources.filter(r => calcResourceWeekPercent(r.id).some(v => v > 100)).length;
    }
    document.getElementById('statLoad').textContent = avgLoad + '%';
    document.getElementById('sidebarUtil').textContent = avgLoad + '%';
    document.getElementById('sidebarUtil').className = 'stat-mini-value ' + (avgLoad > 100 ? 'red' : avgLoad > 85 ? 'amber' : 'green');
    document.getElementById('statRisks').textContent = riskCount;
    document.getElementById('sidebarRisk').textContent = riskCount;
}

// ─── Dashboard ───────────────────────────────────────────
function renderDashboard() {
    updateStats();
    renderFilters('dashboardFilters');
    renderPipelineListCompact('pipelineListDashboard', 8);
    renderHeatmap('heatmapTable');
    renderAllocationDashboard();
}

// ─── Filters ─────────────────────────────────────────────
function renderFilters(containerId) {
    const c = document.getElementById(containerId);
    let html = portfolioItems.map(pi =>
        '<span class="filter-tag ' + (currentFilters.portfolioItem === pi.id ? 'active' : '') + '" onclick="setFilter(\'portfolioItem\',\'' + pi.id + '\')">' + esc(pi.label) + '</span>'
    ).join('');
    html += '<span class="filter-divider"></span>';
    html += '<select class="filter-select" onchange="setFilter(\'resource\',this.value)">' +
        '<option value="all" ' + (currentFilters.resource === 'all' ? 'selected' : '') + '>All Resources</option>' +
        resources.map(r => '<option value="' + esc(r.id) + '" ' + (currentFilters.resource === r.id ? 'selected' : '') + '>' + esc(r.name) + ' (' + esc(r.id) + ')</option>').join('') +
        '</select>';
    c.innerHTML = html;
}

function setFilter(type, value) { currentFilters[type] = value; renderCurrentPage(); }

// ─── Pipeline / Backlog List ─────────────────────────────
// Compact version for dashboard — title + status only
function renderPipelineListCompact(containerId, limit) {
    const c = document.getElementById(containerId);
    let items = workItems.filter(w => w.status !== 'complete');
    if (currentFilters.portfolioItem !== 'all') items = items.filter(w => w.portfolioItem === currentFilters.portfolioItem);
    if (currentFilters.resource !== 'all') items = items.filter(w => (w.assignedResources || []).includes(currentFilters.resource));
    const display = limit ? items.slice(0, limit) : items;
    const remaining = limit ? items.length - limit : 0;
    if (!display.length) { c.innerHTML = '<div class="empty-state">No work items</div>'; return; }
    c.innerHTML = display.map(w => {
        const statusLabel = w.status === 'progress' ? 'in progress' : w.status;
        return '<div class="pipeline-item-compact" onclick="editWorkItem(\'' + esc(w.id) + '\')">' +
            '<div class="pipeline-title-compact">' + esc(w.title) + '</div>' +
            '<span class="pipeline-status status-' + w.status + '">' + statusLabel + '</span></div>';
    }).join('');
    if (remaining > 0) c.innerHTML += '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:var(--fs-xxs)">+' + remaining + ' more</div>';
}

// Full version for backlog page
function renderPipelineList(containerId, limit) {
    const c = document.getElementById(containerId);
    let items = workItems.filter(w => w.status !== 'complete');
    if (currentFilters.portfolioItem !== 'all') items = items.filter(w => w.portfolioItem === currentFilters.portfolioItem);
    if (currentFilters.resource !== 'all') items = items.filter(w => (w.assignedResources || []).includes(currentFilters.resource));
    const display = limit ? items.slice(0, limit) : items;
    const remaining = limit ? items.length - limit : 0;
    if (!display.length) { c.innerHTML = '<div class="empty-state">No work items</div>'; return; }
    c.innerHTML = display.map(w => {
        const effortDays = getEffortDays(w.size || 'M');
        const ftePct = getWiFTEPercent(w);
        const statusLabel = w.status === 'progress' ? 'in progress' : w.status;
        const rids = w.assignedResources || [];
        const resHtml = rids.length > 0
            ? rids.slice(0, 2).map(id => { const r = getRes(id); return r ? '<span class="pipeline-resource"><span class="pipeline-resource-avatar" style="background:' + getResourceColor(id) + '">' + getInitials(r.name) + '</span>' + esc(r.id) + '</span>' : ''; }).join('') + (rids.length > 2 ? '<span style="color:var(--text-muted);font-size:var(--fs-xxs)">+' + (rids.length - 2) + '</span>' : '')
            : '<span class="pipeline-resource">--</span>';
        const dateStr = w.startDate ? new Date(w.startDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
        const piLabel = (portfolioItems.find(p => p.id === w.portfolioItem) || {}).label || w.portfolioItem;
        return '<div class="pipeline-item" onclick="editWorkItem(\'' + esc(w.id) + '\')">' +
            '<div class="pipeline-info"><div class="pipeline-title">' + esc(w.title) + '</div>' +
            '<div class="pipeline-meta">' + esc(piLabel) + (dateStr ? ' · ' + dateStr : '') + '</div></div>' +
            resHtml +
            '<span class="pipeline-effort">' + (w.size || 'M') + ' · ' + effortDays + 'd</span>' +
            '<span class="pipeline-effort">' + ftePct + '% FTE</span>' +
            '<span class="pipeline-status status-' + w.status + '">' + statusLabel + '</span>' +
            '<button class="delete-btn" onclick="event.stopPropagation();deleteWorkItem(\'' + esc(w.id) + '\')">×</button></div>';
    }).join('');
    if (remaining > 0) c.innerHTML += '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:var(--fs-xs)">+' + remaining + ' more items</div>';
}

function renderPipelinePage() { renderFilters('pipelineFiltersPage'); renderPipelineList('pipelineListPage'); }

// ─── Kanban ──────────────────────────────────────────────
function renderKanban() {
    renderFilters('kanbanFilters');
    const statuses = ['upcoming', 'progress', 'blocked', 'complete'];
    const statusNames = { upcoming: 'Upcoming', progress: 'In Progress', blocked: 'Blocked', complete: 'Complete' };
    let items = [...workItems];
    if (currentFilters.portfolioItem !== 'all') items = items.filter(w => w.portfolioItem === currentFilters.portfolioItem);
    if (currentFilters.resource !== 'all') items = items.filter(w => (w.assignedResources || []).includes(currentFilters.resource));
    const c = document.getElementById('kanbanContainer');
    c.innerHTML = statuses.map(status => {
        const si = items.filter(w => w.status === status);
        return '<div class="kanban-column"><div class="kanban-header"><span class="kanban-title">' + statusNames[status] + '</span><span class="kanban-count">' + si.length + '</span></div>' +
            '<div class="kanban-body">' + (si.map(w => {
                const ftePct = getWiFTEPercent(w);
                const rids = w.assignedResources || [];
                const resHtml = rids.length > 0
                    ? rids.slice(0, 1).map(id => { const r = getRes(id); return r ? '<div class="kanban-card-resource"><span class="kanban-card-avatar" style="background:' + getResourceColor(id) + '">' + getInitials(r.name) + '</span>' + esc(r.name) + '</div>' : ''; }).join('')
                    : '<div class="kanban-card-resource">Unassigned</div>';
                const piLabel = (portfolioItems.find(p => p.id === w.portfolioItem) || {}).label || '';
                return '<div class="kanban-card" onclick="editWorkItem(\'' + esc(w.id) + '\')">' +
                    '<div class="kanban-card-title">' + esc(w.title) + '</div>' +
                    '<div class="kanban-card-meta">' + esc(piLabel) + '</div>' +
                    '<div class="kanban-card-footer">' + resHtml + '<span class="kanban-card-effort">' + (w.size || 'M') + ' · ' + ftePct + '%</span></div></div>';
            }).join('') || '<div class="empty-state">No items</div>') + '</div></div>';
    }).join('');
}

// ─── Allocation Dashboard ────────────────────────────────
function renderAllocationDashboard() {
    const c = document.getElementById('allocationListDashboard');
    if (!resources.length) { c.innerHTML = '<div class="empty-state">No resources</div>'; return; }
    const sorted = [...resources].map(r => {
        const w = calcResourceWeekPercent(r.id);
        const avg = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        return { ...r, avg };
    }).sort((a, b) => b.avg - a.avg).slice(0, 5);
    c.innerHTML = sorted.map(r => {
        const cc = r.avg < 85 ? 'green' : r.avg < 100 ? 'amber' : 'red';
        return '<div class="allocation-item"><div class="allocation-avatar" style="background:' + getResourceColor(r.id) + '">' + getInitials(r.name) + '</div>' +
            '<div class="allocation-info"><div class="allocation-name">' + esc(r.name) + '</div><div class="allocation-role">' + esc(r.role || '') + '</div></div>' +
            '<div class="allocation-bar"><div class="allocation-bar-track"><div class="allocation-bar-fill ' + cc + '" style="width:' + Math.min(r.avg, 100) + '%"></div></div></div>' +
            '<div class="allocation-percent" style="color:' + (r.avg > 100 ? 'var(--brand-oxblood)' : r.avg > 85 ? 'var(--brand-amber)' : 'var(--accent-green)') + '">' + r.avg + '%</div></div>';
    }).join('');
    if (resources.length > 5) c.innerHTML += '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:var(--fs-xs)">+' + (resources.length - 5) + ' more</div>';
}

// ─── Heatmap ─────────────────────────────────────────────
function renderHeatmap(tableId) {
    const t = document.getElementById(tableId);
    if (!resources.length) { t.innerHTML = '<tr><td class="empty-state">No resources</td></tr>'; return; }
    const display = tableId === 'heatmapTable' ? resources.slice(0, 5) : resources;
    let html = '<tr><th>Resource</th>' + weekLabels.map(l => '<th>' + l + '</th>').join('') + '<th>Avg</th></tr>';
    display.forEach(r => {
        const w = calcResourceWeekPercent(r.id);
        const wd = calcResourceWeekDays(r.id);
        const avail = getResourceAvailableDays(r.id);
        const avg = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        html += '<tr><td>' + esc(r.name) + '<span class="person-id">' + esc(r.id) + '</span></td>' +
            w.map((v, i) => '<td><div class="heatmap-cell ' + heatClass(v) + '" title="' + wd[i] + 'd / ' + avail + 'd">' + v + '%</div></td>').join('') +
            '<td><div class="heatmap-cell ' + heatClass(avg) + '">' + avg + '%</div></td></tr>';
    });
    if (tableId === 'heatmapTableFull' || resources.length <= 5) {
        const teamAvg = [0, 1, 2, 3].map(i => Math.round(resources.reduce((s, r) => s + (calcResourceWeekPercent(r.id)[i]), 0) / resources.length));
        const totalAvg = Math.round(teamAvg.reduce((a, b) => a + b, 0) / 4);
        html += '<tr style="border-top:2px solid var(--border-accent)"><td><strong>Team</strong></td>' +
            teamAvg.map(v => '<td><div class="heatmap-cell ' + heatClass(v) + '"><strong>' + v + '%</strong></div></td>').join('') +
            '<td><div class="heatmap-cell ' + heatClass(totalAvg) + '"><strong>' + totalAvg + '%</strong></div></td></tr>';
    }
    if (tableId === 'heatmapTable' && resources.length > 5) {
        html += '<tr><td colspan="' + (weekLabels.length + 2) + '" style="text-align:center;padding:10px;color:var(--text-muted);font-size:var(--fs-xs)">+' + (resources.length - 5) + ' more</td></tr>';
    }
    t.innerHTML = html;
}

// ─── Resources ───────────────────────────────────────────
function renderResources() {
    const g = document.getElementById('resourcesGrid');
    if (!resources.length) { g.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No resources added yet</div>'; return; }
    g.innerHTML = resources.map((r, i) => {
        const w = calcResourceWeekPercent(r.id);
        const avg = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        const availDays = getResourceAvailableDays(r.id);
        const assignedCount = workItems.filter(wi => (wi.assignedResources || []).includes(r.id) && wi.status !== 'complete').length;
        const peakWeek = Math.max(...w);
        return '<div class="resource-card" onclick="editResource(\'' + esc(r.id) + '\')">' +
            '<button class="delete-btn" onclick="event.stopPropagation();deleteResource(\'' + esc(r.id) + '\')">×</button>' +
            '<div class="resource-header"><div class="resource-avatar" style="background:' + avatarColors[i % avatarColors.length] + '">' + getInitials(r.name) + '</div>' +
            '<div class="resource-info"><h3>' + esc(r.name) + '<span class="person-id">' + esc(r.id) + '</span></h3><p>' + esc(r.role || '') + '</p></div></div>' +
            '<div class="resource-stats"><div class="resource-stat"><div class="resource-stat-label">Available</div><div class="resource-stat-value">' + availDays + 'd/wk</div></div>' +
            '<div class="resource-stat"><div class="resource-stat-label">Avg Util</div><div class="resource-stat-value" style="color:' + (avg > 100 ? 'var(--brand-oxblood)' : avg > 85 ? 'var(--brand-amber)' : 'var(--accent-green)') + '">' + avg + '%</div></div></div>' +
            '<div class="resource-stats"><div class="resource-stat"><div class="resource-stat-label">Work Items</div><div class="resource-stat-value">' + assignedCount + '</div></div>' +
            '<div class="resource-stat"><div class="resource-stat-label">Peak Week</div><div class="resource-stat-value" style="color:' + (peakWeek > 100 ? 'var(--brand-oxblood)' : peakWeek > 85 ? 'var(--brand-amber)' : 'var(--accent-green)') + '">' + peakWeek + '%</div></div></div></div>';
    }).join('');
}

// ─── Work Item CRUD ──────────────────────────────────────
function openWorkItemModal(id) {
    document.getElementById('workItemModal').classList.add('active');
    currentAssignments = [];
    if (id) {
        const w = workItems.find(x => x.id === id);
        if (w) {
            document.getElementById('wiModalTitle').textContent = 'Edit Work Item';
            document.getElementById('editWiId').value = w.id;
            document.getElementById('wiTitle').value = w.title || '';
            document.getElementById('wiPortfolioItem').value = w.portfolioItem || 'adhoc';
            document.getElementById('wiSize').value = w.size || 'M';
            document.getElementById('wiDuration').value = w.duration || 20;
            document.getElementById('wiStatus').value = w.status || 'upcoming';
            currentAssignments = [...(w.assignedResources || [])];
            document.getElementById('wiStartDate').value = w.startDate || '';
            renderAssignmentRows();
            updateEstimation();
            updateStartDateHint();
            return;
        }
    }
    document.getElementById('wiModalTitle').textContent = 'New Work Item';
    document.getElementById('editWiId').value = '';
    document.getElementById('wiTitle').value = '';
    document.getElementById('wiPortfolioItem').value = 'pstom';
    document.getElementById('wiSize').value = 'M';
    document.getElementById('wiDuration').value = '20';
    document.getElementById('wiStatus').value = 'upcoming';
    document.getElementById('wiStartDate').value = '';
    renderAssignmentRows();
    updateEstimation();
    updateStartDateHint();
}

function editWorkItem(id) { openWorkItemModal(id); }

function saveWorkItem() {
    const title = document.getElementById('wiTitle').value.trim();
    if (!title) { toast('Title required', true); return; }
    const id = document.getElementById('editWiId').value || ('WI' + Date.now());
    const startDate = document.getElementById('wiStartDate').value || '';
    const duration = parseInt(document.getElementById('wiDuration').value) || 20;
    let status = document.getElementById('wiStatus').value;

    // Auto-derive status from start date if set (unless manually set to blocked/complete)
    if (startDate && status !== 'blocked' && status !== 'complete') {
        status = deriveStatus(startDate, duration);
    }

    const item = {
        id, title,
        portfolioItem: document.getElementById('wiPortfolioItem').value,
        size: document.getElementById('wiSize').value,
        duration,
        startDate,
        status,
        assignedResources: currentAssignments.filter(r => r)
    };
    const idx = workItems.findIndex(w => w.id === id);
    if (idx >= 0) workItems[idx] = item;
    else workItems.push(item);
    save();
    closeModal('workItemModal');
    renderCurrentPage();
    toast(idx >= 0 ? 'Updated' : 'Added');
}

function deleteWorkItem(id) {
    const wi = workItems.find(w => w.id === id);
    if (!wi) return;

    const assignedNames = (wi.assignedResources || []).map(rid => {
        const r = getRes(rid);
        return r ? r.name : rid;
    });

    const details = assignedNames.length > 0
        ? 'Assigned to: ' + assignedNames.join(', ')
        : 'No resources assigned';

    showConfirm(
        'Delete Work Item',
        'Are you sure you want to delete "' + wi.title + '"? This can be undone.',
        details,
        function () {
            pushUndo('deleteWorkItem', wi, 'delete "' + wi.title + '"');
            workItems = workItems.filter(w => w.id !== id);
            save();
            renderCurrentPage();
            toast('Deleted "' + wi.title + '"', false, true);
        }
    );
}

// ─── Resource CRUD ───────────────────────────────────────
function openResourceModal(id) {
    document.getElementById('resourceModal').classList.add('active');
    if (id) {
        const r = resources.find(x => x.id === id);
        if (r) {
            document.getElementById('resModalTitle').textContent = 'Edit Resource';
            document.getElementById('editResId').value = r.id;
            document.getElementById('resRole').value = r.role || '';
            document.getElementById('autoIdValue').textContent = r.id;
            document.getElementById('resName').value = r.name || '';
            document.getElementById('resFTE').value = r.totalFTE ?? 1;
            document.getElementById('resBaseline').value = r.baselineCommitment ?? 0;
            document.getElementById('resRole').disabled = true;
            return;
        }
    }
    document.getElementById('resModalTitle').textContent = 'New Resource';
    document.getElementById('editResId').value = '';
    document.getElementById('resRole').value = '';
    document.getElementById('resRole').disabled = false;
    document.getElementById('autoIdValue').textContent = '--';
    document.getElementById('resName').value = '';
    document.getElementById('resFTE').value = '1.0';
    document.getElementById('resBaseline').value = '0';
}

function editResource(id) { openResourceModal(id); }

function saveResource() {
    const existingId = document.getElementById('editResId').value;
    const role = document.getElementById('resRole').value;
    const name = document.getElementById('resName').value.trim();
    if (!role) { toast('Role required', true); return; }
    if (!name) { toast('Name required', true); return; }
    let newId = existingId;
    if (!existingId) { newId = generateResourceId(role); if (!newId) { toast('Invalid role', true); return; } }
    const r = {
        id: newId, name, role,
        totalFTE: parseFloat(document.getElementById('resFTE').value) || 1,
        baselineCommitment: parseFloat(document.getElementById('resBaseline').value) || 0
    };
    if (existingId) {
        const idx = resources.findIndex(x => x.id === existingId);
        if (idx >= 0) resources[idx] = r;
    } else {
        resources.push(r);
    }
    save();
    closeModal('resourceModal');
    renderCurrentPage();
    toast(existingId ? 'Updated' : 'Added');
}

function deleteResource(id) {
    const r = resources.find(x => x.id === id);
    if (!r) return;

    // Find affected work items
    const affected = workItems.filter(w => (w.assignedResources || []).includes(id));
    const affectedDetails = affected.length > 0
        ? 'This resource is assigned to ' + affected.length + ' work item(s): ' +
        affected.slice(0, 3).map(w => '"' + w.title + '"').join(', ') +
        (affected.length > 3 ? ' and ' + (affected.length - 3) + ' more' : '') +
        '. They will be unassigned.'
        : null;

    showConfirm(
        'Delete Resource',
        'Are you sure you want to delete ' + r.name + ' (' + r.id + ')? This can be undone.',
        affectedDetails,
        function () {
            // Save undo data including affected work items' original assignments
            const undoData = {
                resource: { ...r },
                affectedItems: affected.map(w => ({ id: w.id, assignedResources: [...(w.assignedResources || [])] }))
            };
            pushUndo('deleteResource', undoData, 'delete ' + r.name);

            resources = resources.filter(x => x.id !== id);
            workItems.forEach(w => {
                if (w.assignedResources) w.assignedResources = w.assignedResources.filter(x => x !== id);
            });
            save();
            renderCurrentPage();
            toast('Deleted ' + r.name, false, true);
        }
    );
}

// ─── CSV Parsing ─────────────────────────────────────────
function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(l => parseCSVLine(l));
    return { headers, rows };
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
    }
    result.push(current.trim());
    return result;
}

function getCSVField(row, headers, fieldName) {
    const idx = headers.findIndex(h => h.toLowerCase().replace(/[^a-z]/g, '') === fieldName.toLowerCase().replace(/[^a-z]/g, ''));
    return idx >= 0 && idx < row.length ? row[idx] : '';
}

// ─── CSV Import: Work Items ──────────────────────────────
function importWorkItemsCSV(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = ''; // Reset so same file can be re-selected

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const { headers, rows } = parseCSV(e.target.result);
            if (!headers.length) { toast('Empty CSV file', true); return; }

            let imported = 0, skipped = 0;

            rows.forEach(row => {
                const title = getCSVField(row, headers, 'title');
                if (!title) { skipped++; return; }

                const id = getCSVField(row, headers, 'id') || ('WI' + Date.now() + Math.random().toString(36).slice(2, 6));
                const portfolioItem = getCSVField(row, headers, 'portfolioitem') || 'adhoc';
                const sizeRaw = getCSVField(row, headers, 'size').toUpperCase();
                const size = ['XS', 'S', 'M', 'L', 'XL', 'XXL'].includes(sizeRaw) ? sizeRaw : 'M';
                const duration = Math.max(1, Math.min(260, parseInt(getCSVField(row, headers, 'duration')) || 20));
                const startDate = getCSVField(row, headers, 'startdate');
                const statusRaw = getCSVField(row, headers, 'status').toLowerCase();
                let status = ['upcoming', 'progress', 'blocked', 'complete'].includes(statusRaw) ? statusRaw : 'upcoming';

                // Derive status from date if applicable
                if (startDate && isValidDateStr(startDate) && status !== 'blocked' && status !== 'complete') {
                    status = deriveStatus(startDate, duration);
                }

                const item = {
                    id, title,
                    portfolioItem: ['pstom', 'integration', 'strategic', 'adhoc'].includes(portfolioItem) ? portfolioItem : 'adhoc',
                    size, duration,
                    startDate: isValidDateStr(startDate) ? startDate : '',
                    status,
                    assignedResources: []
                };

                // Check for duplicate ID
                const existingIdx = workItems.findIndex(w => w.id === id);
                if (existingIdx >= 0) {
                    workItems[existingIdx] = item;
                } else {
                    workItems.push(item);
                }
                imported++;
            });

            save();
            renderCurrentPage();
            toast('Imported ' + imported + ' work items' + (skipped > 0 ? ', ' + skipped + ' skipped' : ''));
        } catch (err) {
            console.error('CSV import error:', err);
            toast('Failed to parse CSV file', true);
        }
    };
    reader.readAsText(file);
}

// ─── CSV Import: Resources ───────────────────────────────
function importResourcesCSV(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const { headers, rows } = parseCSV(e.target.result);
            if (!headers.length) { toast('Empty CSV file', true); return; }

            let imported = 0, skipped = 0;

            rows.forEach(row => {
                const name = getCSVField(row, headers, 'name');
                const role = getCSVField(row, headers, 'role');

                if (!name || !role) { skipped++; return; }
                if (!validRoles.includes(role)) { skipped++; return; }

                const id = generateResourceId(role);
                if (!id) { skipped++; return; }

                const totalFTE = Math.max(0.1, Math.min(1.0, parseFloat(getCSVField(row, headers, 'totalfte')) || 1));
                const baselineCommitment = Math.max(0, Math.min(1.0, parseFloat(getCSVField(row, headers, 'baselinecommitment')) || 0));

                resources.push({ id, name, role, totalFTE, baselineCommitment });
                imported++;
            });

            save();
            renderCurrentPage();
            toast('Imported ' + imported + ' resources' + (skipped > 0 ? ', ' + skipped + ' skipped' : ''));
        } catch (err) {
            console.error('CSV import error:', err);
            toast('Failed to parse CSV file', true);
        }
    };
    reader.readAsText(file);
}

// ─── Export ──────────────────────────────────────────────
function exportAllData() {
    let wi = 'ID,Title,PortfolioItem,Size,EffortDays,Duration,StartDate,FTE%,Status,AssignedResources\n';
    workItems.forEach(w => {
        const ed = getEffortDays(w.size || 'M');
        const fte = getWiFTEPercent(w);
        wi += [w.id, '"' + (w.title || '').replace(/"/g, '""') + '"', w.portfolioItem,
            w.size || 'M', ed, w.duration || 20,
            w.startDate || '', fte + '%', w.status, '"' + (w.assignedResources || []).join(';') + '"'].join(',') + '\n';
    });
    downloadBlob(wi, 'workitems_export.csv');

    let res = 'ID,Name,Role,TotalFTE,BaselineCommitment,AvailableDaysPerWeek\n';
    resources.forEach(r => {
        res += [r.id, '"' + (r.name || '') + '"', '"' + (r.role || '') + '"', r.totalFTE || 1, r.baselineCommitment || 0, getResourceAvailableDays(r.id)].join(',') + '\n';
    });
    downloadBlob(res, 'resources_export.csv');
    toast('2 files exported');
}

function exportCapacity() {
    let csv = 'Resource,ID,Role,AvailableDays,' + weekLabels.map(l => l + ' (%)').join(',') + ',' + weekLabels.map(l => l + ' (days)').join(',') + ',Average %\n';
    resources.forEach(r => {
        const w = calcResourceWeekPercent(r.id);
        const wDays = calcResourceWeekDays(r.id);
        const avg = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        csv += ['"' + r.name + '"', r.id, '"' + (r.role || '') + '"', getResourceAvailableDays(r.id), ...w, ...wDays.map(d => d.toFixed(1)), avg].join(',') + '\n';
    });
    downloadBlob(csv, 'capacity_export.csv');
    toast('Exported');
}

function downloadBlob(content, filename) {
    const blob = new Blob([content], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
}

function downloadTemplate(type) {
    let csv = '';
    if (type === 'workitems') csv = 'ID,Title,PortfolioItem,Size,Duration,StartDate,Status\nWI001,Example Task,pstom,M,20,2025-02-10,upcoming\n';
    if (type === 'resources') csv = 'Name,Role,TotalFTE,BaselineCommitment\nJane Smith,Project Manager,1.0,0.2\n';
    downloadBlob(csv, type + '_template.csv');
}

// ─── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { load(); renderDashboard(); });
