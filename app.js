/* CSU Resource Planner v3 */
const DAYS_PER_FTE = 5;
let workItems = [];
let resources = [];
let categories = [
    'Change Management', 'Impact Assessment', 'Project Delivery',
    'Business Analysis', 'Service Design', 'Benefits Measurement',
    'Performance Measurement', 'Process Mapping', 'Stakeholder Engagement',
    'Data Analysis', 'Communications', 'Training & Development'
];
let lastUpdated = null;
let currentPage = 'dashboard';
let currentFilters = { portfolioItem: 'all', resource: 'all' };
let currentAssignments = []; // resource IDs assigned to current work item

// T-shirt size → effort days mapping (configurable defaults)
const sizeDefaults = { S: 3, M: 7, L: 15, XL: 30 };

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
    'Change Manager': 'CM', 'Head of Change': 'CM',
    'Project Manager': 'PM', 'Head of PMO': 'PM',
    'Project Analyst': 'PBA', 'Business Analyst': 'PBA',
    'Project Support Officer': 'PSO', 'Director of Change': 'DC'
};

// Week labels (4-week rolling)
function getWeekLabels() {
    const labels = [];
    const today = new Date();
    const dow = today.getDay();
    const mon = new Date(today);
    mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    for (let i = 0; i < 4; i++) {
        const ws = new Date(mon);
        ws.setDate(mon.getDate() + (i * 7));
        labels.push('W/C ' + ws.getDate() + ' ' + ws.toLocaleString('en-GB', { month: 'short' }));
    }
    return labels;
}
const weekLabels = getWeekLabels();

// ─── Storage ─────────────────────────────────────────────
function save() {
    lastUpdated = new Date().toISOString();
    localStorage.setItem('csu_v3', JSON.stringify({ workItems, resources, categories, lastUpdated }));
    updateLastUpdated();
}

function load() {
    try {
        const d = JSON.parse(localStorage.getItem('csu_v3'));
        if (d) {
            workItems = d.workItems || [];
            resources = d.resources || [];
            categories = d.categories || categories;
            lastUpdated = d.lastUpdated;
        }
    } catch (e) { console.error(e); }
    updateLastUpdated();
}

function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (lastUpdated) {
        const d = new Date(lastUpdated);
        el.textContent = 'Updated: ' + d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

// ─── Utilities ───────────────────────────────────────────
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' error' : '');
    setTimeout(() => t.className = 'toast', 3000);
}
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function getRes(id) { return resources.find(r => r.id === id); }
function heatClass(v) {
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

// ─── Estimation Model ────────────────────────────────────
// Each work item has: size (S/M/L/XL), duration (calendar days), assignedResources [resourceId...]
// FTE% = effortDays / duration
// Per person FTE% = FTE% / numAssigned

function getEffortDays(size) {
    return sizeDefaults[size] || sizeDefaults.M;
}

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

// ─── Capacity Calculations ───────────────────────────────
// Resource available days per week = (totalFTE - baseline) * 5
function getResourceAvailableDays(rid) {
    const r = resources.find(x => x.id === rid);
    if (!r) return 0;
    const netFTE = (r.totalFTE || 1) - (r.baselineCommitment || 0);
    return Math.max(0, netFTE * DAYS_PER_FTE);
}

// Calculate per-week FTE% load for a resource across all active work items
// A work item contributes perPersonFTE% to each assigned resource for each week it spans
function calcResourceWeekPercent(rid) {
    const wp = [0, 0, 0, 0];
    workItems.forEach(wi => {
        if (wi.status === 'complete') return;
        if (!(wi.assignedResources || []).includes(rid)) return;
        const perPerson = getWiPerPersonFTE(wi);
        // Apply to all 4 weeks (rolling view — item spans its duration)
        for (let i = 0; i < 4; i++) wp[i] += perPerson;
    });
    return wp.map(v => Math.round(v * 10) / 10);
}

// Convert FTE% to days for display
function calcResourceWeekDays(rid) {
    const avail = getResourceAvailableDays(rid);
    const wp = calcResourceWeekPercent(rid);
    return wp.map(p => Math.round((p / 100) * avail * 10) / 10);
}

// ─── Estimation UI in Modal ──────────────────────────────
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
    const numRes = currentAssignments.length;
    const el = document.getElementById('ftePerPerson');

    if (numRes === 0) {
        el.textContent = ftePct + '% (unassigned)';
    } else {
        const perPerson = Math.round((ftePct / numRes) * 10) / 10;
        el.textContent = perPerson + '% each (' + numRes + ' resource' + (numRes > 1 ? 's' : '') + ')';
    }
}

// ─── Resource Assignment Rows ────────────────────────────
function renderAssignmentRows() {
    const c = document.getElementById('assignmentRows');
    if (currentAssignments.length === 0) {
        c.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:var(--fs-xs)">No resources assigned. Click "+ Add Resource".</div>';
        return;
    }
    c.innerHTML = currentAssignments.map((rid, i) =>
        '<div class="assignment-row">' +
        '<select class="form-select" onchange="updateAssignment(' + i + ',this.value)">' +
        '<option value="">-- Select Resource --</option>' +
        resources.map(r => '<option value="' + esc(r.id) + '" ' + (rid === r.id ? 'selected' : '') + '>' + esc(r.name) + ' (' + esc(r.id) + ')</option>').join('') +
        '</select>' +
        '<div class="assignment-fte" id="assignFte' + i + '"></div>' +
        '<button class="delete-btn" onclick="removeAssignment(' + i + ')">×</button>' +
        '</div>'
    ).join('');
    updateAssignmentFTEs();
}

function addAssignmentRow() {
    currentAssignments.push('');
    renderAssignmentRows();
    updateFTEPerPerson();
    renderSuggestions();
}

function removeAssignment(i) {
    currentAssignments.splice(i, 1);
    renderAssignmentRows();
    updateFTEPerPerson();
    renderSuggestions();
}

function updateAssignment(i, val) {
    currentAssignments[i] = val;
    updateAssignmentFTEs();
    updateFTEPerPerson();
    renderSuggestions();
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

function addSuggestedResource(rid) {
    if (!currentAssignments.includes(rid)) {
        currentAssignments.push(rid);
    }
    renderAssignmentRows();
    updateFTEPerPerson();
    renderSuggestions();
}

// ─── Suggestions ─────────────────────────────────────────
function getSuggestions(cat) {
    if (!resources.length) return [];
    return resources.map(r => {
        const sk = r.skills || {};
        const lvl = sk[cat] || 0;
        const score = lvl / 5;
        const wp = calcResourceWeekPercent(r.id);
        const avgLoad = wp.reduce((a, b) => a + b, 0) / 4;
        const avail = Math.max(0, (100 - avgLoad) / 100);
        return { resource: r, skillLevel: lvl, avgLoad: Math.round(avgLoad), combinedScore: (score * 0.6) + (avail * 0.4) };
    }).filter(s => s.combinedScore > 0.1 && !currentAssignments.includes(s.resource.id))
      .sort((a, b) => b.combinedScore - a.combinedScore).slice(0, 4);
}

function renderSuggestions() {
    const c = document.getElementById('suggestionList');
    const cat = document.getElementById('wiCategory').value;
    const sugg = getSuggestions(cat);
    if (!sugg.length) {
        c.innerHTML = '<div class="no-suggestions">No matching resources found.</div>';
        return;
    }
    c.innerHTML = sugg.map(s => {
        const r = s.resource;
        const col = s.avgLoad > 100 ? 'var(--brand-oxblood)' : s.avgLoad > 85 ? 'var(--brand-amber)' : 'var(--accent-green)';
        return '<div class="suggestion-item" onclick="addSuggestedResource(\'' + esc(r.id) + '\')">' +
            '<div class="suggestion-info"><div class="suggestion-avatar" style="background:' + getResourceColor(r.id) + '">' + getInitials(r.name) + '</div>' +
            '<div class="suggestion-details"><h4>' + esc(r.name) + '</h4><p>' + esc(r.role || '') + '</p></div></div>' +
            '<div class="suggestion-stats">' +
            '<div class="suggestion-stat"><div class="suggestion-stat-value">' + s.skillLevel + '/5</div><div class="suggestion-stat-label">Skill</div></div>' +
            '<div class="suggestion-stat"><div class="suggestion-stat-value" style="color:' + col + '">' + s.avgLoad + '%</div><div class="suggestion-stat-label">Load</div></div>' +
            '</div></div>';
    }).join('');
}

// ─── Navigation ──────────────────────────────────────────
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    document.querySelector('.nav-item[data-page="' + page + '"]')?.classList.add('active');
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
    else if (currentPage === 'skills') renderSkillsMatrix();
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
        const loads = resources.map(r => {
            const w = calcResourceWeekPercent(r.id);
            return w.reduce((a, b) => a + b, 0) / w.length;
        });
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
    renderPipelineList('pipelineListDashboard', 5);
    renderHeatmap('heatmapTable');
    renderAllocationDashboard();
    renderCategoryCoverage();
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
            ? rids.slice(0, 2).map(id => {
                const r = getRes(id);
                return r ? '<span class="pipeline-resource"><span class="pipeline-resource-avatar" style="background:' + getResourceColor(id) + '">' + getInitials(r.name) + '</span>' + esc(r.id) + '</span>' : '';
            }).join('') + (rids.length > 2 ? '<span style="color:var(--text-muted);font-size:var(--fs-xxs)">+' + (rids.length - 2) + '</span>' : '')
            : '<span class="pipeline-resource">--</span>';
        return '<div class="pipeline-item" onclick="editWorkItem(\'' + esc(w.id) + '\')">' +
            '<div class="pipeline-info"><div class="pipeline-title">' + esc(w.title) + '</div>' +
            '<div class="pipeline-meta">' + esc((portfolioItems.find(p => p.id === w.portfolioItem) || {}).label || w.portfolioItem) + ' · ' + esc(w.category || 'No category') + '</div></div>' +
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
                return '<div class="kanban-card" onclick="editWorkItem(\'' + esc(w.id) + '\')">' +
                    '<div class="kanban-card-title">' + esc(w.title) + '</div>' +
                    '<div class="kanban-card-meta">' + esc((portfolioItems.find(p => p.id === w.portfolioItem) || {}).label || '') + ' · ' + esc(w.category || '') + '</div>' +
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

// ─── Category Coverage ───────────────────────────────────
function renderCategoryCoverage() {
    const c = document.getElementById('categoryCoverage');
    const data = categories.slice(0, 5).map(cat => {
        const cap = resources.reduce((s, r) => s + ((r.skills && r.skills[cat]) || 0) * 20, 0);
        const dem = workItems.filter(w => w.status !== 'complete' && w.category === cat).length * 25;
        return { name: cat, capacity: Math.min(cap, 100), demand: Math.min(dem, 100) };
    });
    if (!data.length) { c.innerHTML = '<div class="empty-state">No categories defined</div>'; return; }
    c.innerHTML = data.map(d => {
        const gap = d.demand - d.capacity;
        const gc = gap > 0 ? 'negative' : gap < 0 ? 'positive' : '';
        return '<div class="category-row"><div class="category-name">' + esc(d.name) + '</div>' +
            '<div class="category-bars"><div class="category-bar"><div class="category-fill capacity" style="width:' + d.capacity + '%"></div></div>' +
            '<div class="category-bar"><div class="category-fill demand" style="width:' + d.demand + '%"></div></div></div>' +
            '<div class="category-gap ' + gc + '">' + (gap > 0 ? '+' : '') + gap + '%</div></div>';
    }).join('');
    if (categories.length > 5) c.innerHTML += '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:var(--fs-xs)">+' + (categories.length - 5) + ' more</div>';
}

// ─── Resources ───────────────────────────────────────────
function renderResources() {
    const g = document.getElementById('resourcesGrid');
    if (!resources.length) { g.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No resources added yet</div>'; return; }
    g.innerHTML = resources.map((r, i) => {
        const w = calcResourceWeekPercent(r.id);
        const avg = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        const availDays = getResourceAvailableDays(r.id);
        const topCats = Object.entries(r.skills || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s]) => s);
        const assignedCount = workItems.filter(wi => (wi.assignedResources || []).includes(r.id) && wi.status !== 'complete').length;
        const peakWeek = Math.max(...w);
        return '<div class="resource-card" onclick="editResource(\'' + esc(r.id) + '\')">' +
            '<button class="delete-btn" onclick="event.stopPropagation();deleteResource(\'' + esc(r.id) + '\')">×</button>' +
            '<div class="resource-header"><div class="resource-avatar" style="background:' + avatarColors[i % avatarColors.length] + '">' + getInitials(r.name) + '</div>' +
            '<div class="resource-info"><h3>' + esc(r.name) + '<span class="person-id">' + esc(r.id) + '</span></h3><p>' + esc(r.role || '') + '</p></div></div>' +
            '<div class="resource-stats"><div class="resource-stat"><div class="resource-stat-label">Available</div><div class="resource-stat-value">' + availDays + 'd/wk</div></div>' +
            '<div class="resource-stat"><div class="resource-stat-label">Avg Util</div><div class="resource-stat-value" style="color:' + (avg > 100 ? 'var(--brand-oxblood)' : avg > 85 ? 'var(--brand-amber)' : 'var(--accent-green)') + '">' + avg + '%</div></div></div>' +
            '<div class="resource-stats"><div class="resource-stat"><div class="resource-stat-label">Work Items</div><div class="resource-stat-value">' + assignedCount + '</div></div>' +
            '<div class="resource-stat"><div class="resource-stat-label">Peak Week</div><div class="resource-stat-value" style="color:' + (peakWeek > 100 ? 'var(--brand-oxblood)' : peakWeek > 85 ? 'var(--brand-amber)' : 'var(--accent-green)') + '">' + peakWeek + '%</div></div></div>' +
            '<div class="resource-categories">' + (topCats.map(s => '<span class="category-tag">' + esc(s) + '</span>').join('') || '<span style="color:var(--text-muted);font-size:12px">No skills rated</span>') + '</div></div>';
    }).join('');
}

// ─── Skills Matrix ───────────────────────────────────────
function renderSkillsMatrix() {
    const t = document.getElementById('skillsTable');
    if (!resources.length) { t.innerHTML = '<tr><td class="empty-state">Add resources first</td></tr>'; return; }

    resources.forEach(r => {
        if (!r.skills) r.skills = {};
        categories.forEach(c => { if (r.skills[c] === undefined) r.skills[c] = 0; });
    });

    let html = '<tr><th>Category</th>' +
        resources.map(r => '<th>' + esc(r.name.split(' ')[0]) + '<br><span style="font-weight:400;font-size:10px;color:var(--text-muted)">' + esc(r.id) + '</span></th>').join('') +
        '<th></th></tr>';

    categories.forEach(cat => {
        html += '<tr><td><span class="category-name-edit" onclick="editCategory(\'' + esc(cat) + '\')" title="Click to edit">' + esc(cat) + '</span></td>' +
            resources.map(r => {
                const lvl = r.skills[cat] || 0;
                return '<td><select class="skill-select level-' + lvl + '" onchange="setSkill(\'' + esc(r.id) + '\',\'' + esc(cat) + '\',parseInt(this.value))">' +
                    [0, 1, 2, 3, 4, 5].map(l => '<option value="' + l + '" ' + (lvl === l ? 'selected' : '') + '>' + l + '</option>').join('') +
                    '</select></td>';
            }).join('') +
            '<td><button class="delete-btn" onclick="deleteCategory(\'' + esc(cat) + '\')">×</button></td></tr>';
    });
    t.innerHTML = html;
}

function setSkill(rid, cat, lvl) {
    const r = resources.find(x => x.id === rid);
    if (!r) return;
    if (!r.skills) r.skills = {};
    r.skills[cat] = lvl;
    save();
    renderSkillsMatrix();
    if (currentPage === 'dashboard') renderCategoryCoverage();
}

// ─── Category CRUD (Add / Edit / Delete) ─────────────────
function openCategoryModal(editName) {
    document.getElementById('categoryModal').classList.add('active');
    document.getElementById('newCategoryName').value = editName || '';
    document.getElementById('editCatOriginal').value = editName || '';
    if (editName) {
        document.getElementById('catModalTitle').textContent = 'Edit Category';
        document.getElementById('catModalSaveBtn').textContent = 'Save';
    } else {
        document.getElementById('catModalTitle').textContent = 'Add Work Item Category';
        document.getElementById('catModalSaveBtn').textContent = 'Add';
    }
}

function editCategory(catName) {
    openCategoryModal(catName);
}

function saveCategory() {
    const name = document.getElementById('newCategoryName').value.trim();
    const original = document.getElementById('editCatOriginal').value;
    if (!name) { toast('Name required', true); return; }

    if (original) {
        // Editing existing
        if (name !== original && categories.includes(name)) { toast('Already exists', true); return; }
        const idx = categories.indexOf(original);
        if (idx >= 0) categories[idx] = name;
        // Update resources skills keys
        resources.forEach(r => {
            if (r.skills && r.skills[original] !== undefined) {
                r.skills[name] = r.skills[original];
                if (name !== original) delete r.skills[original];
            }
        });
        // Update work items
        workItems.forEach(w => { if (w.category === original) w.category = name; });
    } else {
        // Adding new
        if (categories.includes(name)) { toast('Already exists', true); return; }
        categories.push(name);
        resources.forEach(r => { if (!r.skills) r.skills = {}; r.skills[name] = 0; });
    }
    save();
    closeModal('categoryModal');
    renderCurrentPage();
    toast(original ? 'Category updated' : 'Category added');
}

function deleteCategory(cat) {
    if (!confirm('Delete category "' + cat + '"?')) return;
    categories = categories.filter(c => c !== cat);
    resources.forEach(r => { if (r.skills) delete r.skills[cat]; });
    workItems.forEach(w => { if (w.category === cat) w.category = ''; });
    save();
    renderCurrentPage();
    toast('Deleted');
}

// ─── Work Item CRUD ──────────────────────────────────────
function populateCategoryDropdown() {
    const dd = document.getElementById('wiCategory');
    dd.innerHTML = '<option value="">-- Select Category --</option>' +
        categories.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
}

function openWorkItemModal(id) {
    document.getElementById('workItemModal').classList.add('active');
    populateCategoryDropdown();
    currentAssignments = [];

    if (id) {
        const w = workItems.find(x => x.id === id);
        if (w) {
            document.getElementById('wiModalTitle').textContent = 'Edit Work Item';
            document.getElementById('editWiId').value = w.id;
            document.getElementById('wiTitle').value = w.title || '';
            document.getElementById('wiPortfolioItem').value = w.portfolioItem || 'adhoc';
            document.getElementById('wiCategory').value = w.category || '';
            document.getElementById('wiSize').value = w.size || 'M';
            document.getElementById('wiDuration').value = w.duration || 20;
            document.getElementById('wiStatus').value = w.status || 'upcoming';
            currentAssignments = [...(w.assignedResources || [])];
            renderAssignmentRows();
            updateEstimation();
            renderSuggestions();
            return;
        }
    }
    document.getElementById('wiModalTitle').textContent = 'New Work Item';
    document.getElementById('editWiId').value = '';
    document.getElementById('wiTitle').value = '';
    document.getElementById('wiPortfolioItem').value = 'pstom';
    document.getElementById('wiCategory').value = '';
    document.getElementById('wiSize').value = 'M';
    document.getElementById('wiDuration').value = '20';
    document.getElementById('wiStatus').value = 'upcoming';
    renderAssignmentRows();
    updateEstimation();
    renderSuggestions();
}

function editWorkItem(id) { openWorkItemModal(id); }

function saveWorkItem() {
    const title = document.getElementById('wiTitle').value.trim();
    if (!title) { toast('Title required', true); return; }

    const id = document.getElementById('editWiId').value || ('WI' + Date.now());
    const item = {
        id,
        title,
        portfolioItem: document.getElementById('wiPortfolioItem').value,
        category: document.getElementById('wiCategory').value,
        size: document.getElementById('wiSize').value,
        duration: parseInt(document.getElementById('wiDuration').value) || 20,
        status: document.getElementById('wiStatus').value,
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
    if (!confirm('Delete this work item?')) return;
    workItems = workItems.filter(w => w.id !== id);
    save();
    renderCurrentPage();
    toast('Deleted');
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
    if (!existingId) {
        newId = generateResourceId(role);
        if (!newId) { toast('Invalid role', true); return; }
    }

    const r = {
        id: newId, name, role,
        totalFTE: parseFloat(document.getElementById('resFTE').value) || 1,
        baselineCommitment: parseFloat(document.getElementById('resBaseline').value) || 0,
        skills: {}
    };
    if (existingId) {
        const existing = resources.find(x => x.id === existingId);
        if (existing) r.skills = existing.skills || {};
        const idx = resources.findIndex(x => x.id === existingId);
        if (idx >= 0) resources[idx] = r;
    } else {
        categories.forEach(c => r.skills[c] = 0);
        resources.push(r);
    }
    save();
    closeModal('resourceModal');
    renderCurrentPage();
    toast(existingId ? 'Updated' : 'Added');
}

function deleteResource(id) {
    if (!confirm('Delete resource?')) return;
    resources = resources.filter(r => r.id !== id);
    workItems.forEach(w => {
        if (w.assignedResources) w.assignedResources = w.assignedResources.filter(r => r !== id);
    });
    save();
    renderCurrentPage();
    toast('Deleted');
}

// ─── Export ──────────────────────────────────────────────
function exportAllData() {
    let wi = 'ID,Title,PortfolioItem,Category,Size,EffortDays,Duration,FTE%,Status,AssignedResources\n';
    workItems.forEach(w => {
        const ed = getEffortDays(w.size || 'M');
        const fte = getWiFTEPercent(w);
        wi += [w.id, '"' + (w.title || '').replace(/"/g, '""') + '"', w.portfolioItem, '"' + (w.category || '') + '"',
            w.size || 'M', ed, w.duration || 20, fte + '%', w.status, '"' + (w.assignedResources || []).join(';') + '"'].join(',') + '\n';
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
    if (type === 'workitems') csv = 'ID,Title,PortfolioItem,Category,Size,Duration,Status\n';
    if (type === 'resources') csv = 'Name,Role,TotalFTE,BaselineCommitment\n';
    if (type === 'skills') csv = 'ResourceID,Category,Level\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = type + '_template.csv';
    a.click();
}

// ─── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { load(); renderDashboard(); });
