/* ================================================================== */
/*  Karnataka RERA Chatbot — Frontend Logic                            */
/* ================================================================== */

const API_BASE = '';  // same origin
const chatArea = document.getElementById('chat-area');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const typingIndicator = document.getElementById('typing-indicator');
const dataBadge = document.getElementById('data-badge');
const dataBadgeText = document.getElementById('data-badge-text');

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  fetchHealthInfo();
  showWelcomeMessage();
  chatInput.focus();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

/* ------------------------------------------------------------------ */
/*  Health / Data freshness                                            */
/* ------------------------------------------------------------------ */

async function fetchHealthInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();

    if (data.totalProjects > 0) {
      const date = data.lastCrawl?.completedAt
        ? formatRelativeTime(data.lastCrawl.completedAt)
        : 'unknown';
      dataBadgeText.textContent = `${data.totalProjects.toLocaleString()} projects · ${date}`;
      dataBadge.classList.remove('empty', 'stale');

      // Check if data is older than 48 hours
      if (data.lastCrawl?.completedAt) {
        const crawlDate = new Date(data.lastCrawl.completedAt);
        if (Date.now() - crawlDate.getTime() > 48 * 60 * 60 * 1000) {
          dataBadge.classList.add('stale');
        }
      }
    } else {
      dataBadgeText.textContent = 'No data — run crawler';
      dataBadge.classList.add('empty');
    }
  } catch {
    dataBadgeText.textContent = 'Offline';
    dataBadge.classList.add('empty');
  }
}

/* ------------------------------------------------------------------ */
/*  Welcome message                                                    */
/* ------------------------------------------------------------------ */

function showWelcomeMessage() {
  const welcomeHtml = `
    <div>
      <strong>👋 Welcome to the Karnataka RERA Assistant!</strong>
    </div>
    <div style="margin-top:8px; color: var(--text-secondary); font-size: 13px;">
      I can help you search for real estate projects, find promoter information,
      check project statuses, and verify RERA registration numbers.
    </div>
    <div class="quick-actions">
      <button class="chip" onclick="quickAction('Search Prestige projects')">
        <span class="chip-icon">🔍</span> Search Projects
      </button>
      <button class="chip" onclick="quickAction('Projects in Bangalore')">
        <span class="chip-icon">📍</span> By District
      </button>
      <button class="chip" onclick="quickAction('Show approved projects')">
        <span class="chip-icon">✅</span> By Status
      </button>
      <button class="chip" onclick="quickAction('stats')">
        <span class="chip-icon">📊</span> Statistics
      </button>
      <button class="chip" onclick="quickAction('help')">
        <span class="chip-icon">💡</span> Help
      </button>
    </div>
  `;

  addMessage('bot', welcomeHtml, true);
}

/* ------------------------------------------------------------------ */
/*  Send & Receive                                                     */
/* ------------------------------------------------------------------ */

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.focus();

  addMessage('user', escapeHtml(text));
  showTyping(true);

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    const data = await res.json();
    showTyping(false);

    if (data.reply) {
      renderReply(data.reply);
    } else {
      addMessage('bot', 'Something went wrong. Please try again.');
    }
  } catch (err) {
    showTyping(false);
    addMessage('bot', `⚠️ Failed to connect to the server. Make sure it's running on <code>localhost:3000</code>.`);
  }
}

function quickAction(text) {
  chatInput.value = text;
  sendMessage();
}

/* ------------------------------------------------------------------ */
/*  Render bot replies                                                 */
/* ------------------------------------------------------------------ */

function renderReply(reply) {
  switch (reply.type) {
    case 'text':
      addMessage('bot', formatMarkdown(reply.text));
      break;

    case 'projects':
      renderProjectResults(reply);
      break;

    case 'verify':
      renderVerifyResult(reply);
      break;

    default:
      addMessage('bot', formatMarkdown(reply.text || 'No response.'));
  }
}

function renderProjectResults(reply) {
  let html = `<div>${formatMarkdown(reply.text)}</div>`;
  html += `<div class="projects-container">`;

  for (const project of reply.projects) {
    html += buildProjectCard(project);
  }

  html += `</div>`;

  if (reply.projects.length >= 20) {
    html += `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">
      Showing first 20 results. Try a more specific search to narrow down.
    </div>`;
  }

  addMessage('bot', html, true);
}

function renderVerifyResult(reply) {
  let html = `<div>${formatMarkdown(reply.text)}</div>`;

  if (reply.source === 'live') {
    html += `<div class="verify-badge live">✅ Verified live · ${formatTime(reply.verifiedAt)}</div>`;
  } else if (reply.source === 'cache') {
    html += `<div class="verify-badge cache">⚠️ From cache · Portal unreachable</div>`;
  }

  if (reply.project) {
    html += `<div class="projects-container">${buildProjectCard(reply.project)}</div>`;
  }

  addMessage('bot', html, true);
}

/* ------------------------------------------------------------------ */
/*  Project card builder                                               */
/* ------------------------------------------------------------------ */

function buildProjectCard(project) {
  const statusClass = getStatusClass(project.status);
  const cardId = 'card-' + Math.random().toString(36).slice(2, 9);

  let detailsHtml = '';
  if (project.details && Object.keys(project.details).length > 0) {
    detailsHtml = `
      <div class="project-card-details" id="${cardId}-details">
        <div class="detail-grid">
          ${Object.entries(project.details).map(([k, v]) =>
            `<div class="detail-row">
              <span class="d-label">${escapeHtml(k)}</span>
              <span class="d-value">${escapeHtml(String(v))}</span>
            </div>`
          ).join('')}
        </div>
      </div>
      <div class="project-card-expand" onclick="toggleDetails('${cardId}-details', this)">
        ▸ View more details
      </div>`;
  }

  return `
    <div class="project-card" id="${cardId}">
      <div class="project-card-header">
        <div class="project-card-title">${escapeHtml(project.project_name)}</div>
        <span class="project-card-status ${statusClass}">${escapeHtml(project.status)}</span>
      </div>
      <div class="project-card-meta">
        <div class="project-card-field">
          <span class="label">Reg No:</span>
          <span>${escapeHtml(project.rera_reg_no)}</span>
        </div>
        <div class="project-card-field">
          <span class="label">Promoter:</span>
          <span>${escapeHtml(project.promoter_name)}</span>
        </div>
        <div class="project-card-field">
          <span class="label">District:</span>
          <span>${escapeHtml(project.district)}</span>
        </div>
        <div class="project-card-field">
          <span class="label">Taluk:</span>
          <span>${escapeHtml(project.taluk)}</span>
        </div>
      </div>
      ${detailsHtml}
    </div>`;
}

function toggleDetails(id, el) {
  const details = document.getElementById(id);
  if (details) {
    const isExpanded = details.classList.toggle('expanded');
    el.textContent = isExpanded ? '▾ Hide details' : '▸ View more details';
  }
}

function getStatusClass(status) {
  if (!status) return 'status-default';
  const s = status.toLowerCase();
  if (s.includes('approved') || s.includes('registered'))  return 'status-approved';
  if (s.includes('rejected') || s.includes('revoked'))     return 'status-rejected';
  if (s.includes('pending') || s.includes('process') || s.includes('query')) return 'status-pending';
  return 'status-default';
}

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                        */
/* ------------------------------------------------------------------ */

function addMessage(role, content, isHtml = false) {
  const msg = document.createElement('div');
  msg.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'bot' ? '🏗️' : '👤';

  const bubble = document.createElement('div');
  bubble.className = 'msg-content';

  if (isHtml) {
    bubble.innerHTML = content;
  } else {
    bubble.innerHTML = content;
  }

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  chatArea.appendChild(msg);

  scrollToBottom();
}

function showTyping(visible) {
  typingIndicator.classList.toggle('visible', visible);
  if (visible) scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function formatMarkdown(text) {
  if (!text) return '';

  return text
    // Code blocks (```...```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code (`...`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold (**...**)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic (*...*)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Italic (_..._)
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // Bullet points (• or -)
    .replace(/^[•\-]\s+(.+)$/gm, '<div style="padding-left:12px;">• $1</div>')
    // Newlines
    .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  if (!text) return '—';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* Make toggleDetails available globally */
window.toggleDetails = toggleDetails;
window.quickAction = quickAction;
