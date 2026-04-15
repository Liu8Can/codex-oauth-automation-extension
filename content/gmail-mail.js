// content/gmail-mail.js — Content script for Gmail (steps 4, 7)
// Injected dynamically on: mail.google.com

const GMAIL_PREFIX = '[MultiPage:gmail-mail]';
const isTopFrame = window === window.top;

console.log(GMAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(GMAIL_PREFIX, 'Skipping child frame');
} else {

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then((result) => {
      sendResponse(result);
    }).catch((err) => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`步骤 ${message.step}：Gmail 轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDisplayed(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isVisibleElement(el) {
  if (!isDisplayed(el)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findInboxLink() {
  const selectors = [
    'a[href*="#inbox"]',
    'a[aria-label*="收件箱"]',
    'a[aria-label*="Inbox"]',
  ];

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisibleElement);
    if (visible) return visible;
    if (candidates[0]) return candidates[0];
  }

  return Array.from(document.querySelectorAll('a, [role="link"]')).find((el) => {
    const text = normalizeText(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
    return /收件箱|Inbox/i.test(text);
  }) || null;
}

function findRefreshButton() {
  const selectors = [
    'div[role="button"][data-tooltip="刷新"]',
    'div[role="button"][aria-label="刷新"]',
    'div[role="button"][data-tooltip*="刷新"]',
    'div[role="button"][aria-label*="刷新"]',
    'div[role="button"][data-tooltip="Refresh"]',
    'div[role="button"][aria-label="Refresh"]',
    'div[role="button"][data-tooltip*="Refresh"]',
    'div[role="button"][aria-label*="Refresh"]',
    'div[act="20"][role="button"]',
    'div.asf.T-I-J3.J-J5-Ji',
  ];

  for (const selector of selectors) {
    const matched = document.querySelector(selector);
    const button = matched?.closest?.('[role="button"]') || matched;
    if (button && isVisibleElement(button)) {
      return button;
    }
  }

  return Array.from(document.querySelectorAll('div[role="button"], button')).find((el) => {
    const text = normalizeText(
      el.getAttribute('aria-label')
      || el.getAttribute('data-tooltip')
      || el.getAttribute('title')
      || el.textContent
    );
    return /刷新|Refresh/i.test(text);
  }) || null;
}

function collectThreadRows() {
  const candidates = [
    ...document.querySelectorAll('tr.zA'),
    ...document.querySelectorAll('tr[role="row"]'),
  ];

  const rows = [];
  const seen = new Set();

  candidates.forEach((row) => {
    if (!row || seen.has(row)) return;
    seen.add(row);

    if (!isDisplayed(row)) return;

    const text = normalizeText(row.textContent || row.innerText || '');
    if (!text) return;

    if (
      row.matches('tr.zA')
      || row.querySelector('.bog, .y6, .y2, .afn, [data-thread-id], [data-legacy-thread-id], [data-legacy-last-message-id]')
      || /openai|chatgpt|verify|verification|code|验证码/i.test(text)
    ) {
      rows.push(row);
    }
  });

  return rows;
}

function getRowPreviewText(row) {
  const sender = normalizeText(
    row.querySelector('.zF, .yP, span[email], [email]')?.textContent
    || row.querySelector('[email]')?.getAttribute?.('email')
    || ''
  );

  const subject = normalizeText(
    row.querySelector('.bog [data-thread-id], .bog [data-legacy-thread-id], .bog, .y6, .bqe')?.textContent
    || ''
  );

  const digest = normalizeText(
    row.querySelector('.y2, .afn, .a4W, .bog + .y2')?.textContent
    || ''
  );

  const timeText = normalizeText(
    row.querySelector('td.xW span')?.getAttribute?.('title')
    || row.querySelector('td.xW span, td.xW time')?.textContent
    || ''
  );

  const fullText = normalizeText(row.textContent || row.innerText || '');

  return {
    sender,
    subject,
    digest,
    timeText,
    fullText,
    combinedText: normalizeText([sender, subject, digest, timeText, fullText].filter(Boolean).join(' ')),
  };
}

function getRowFingerprint(row, index = 0) {
  const marker = row.querySelector('[data-thread-id], [data-legacy-thread-id], [data-legacy-last-message-id]');
  const stableId = marker?.getAttribute?.('data-thread-id')
    || marker?.getAttribute?.('data-legacy-thread-id')
    || marker?.getAttribute?.('data-legacy-last-message-id')
    || row.getAttribute('id')
    || `row-${index}`;
  const preview = getRowPreviewText(row);
  return `${stableId}::${preview.subject}::${preview.timeText}`.slice(0, 300);
}

function normalizeMinuteTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric / 60000) * 60000;
}

function extractEmails(text) {
  const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return [...new Set(matches.map((item) => item.toLowerCase()))];
}

function emailMatchesTarget(candidate, targetEmail) {
  const normalizedCandidate = String(candidate || '').trim().toLowerCase();
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  return Boolean(normalizedCandidate && normalizedTarget && normalizedCandidate === normalizedTarget);
}

function getTargetEmailMatchState(text, targetEmail) {
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return { matches: true, hasExplicitEmail: false };
  }

  const normalizedText = String(text || '').toLowerCase();
  if (normalizedText.includes(normalizedTarget)) {
    return { matches: true, hasExplicitEmail: true };
  }

  const atIndex = normalizedTarget.indexOf('@');
  if (atIndex > 0) {
    const encodedTarget = `${normalizedTarget.slice(0, atIndex)}=${normalizedTarget.slice(atIndex + 1)}`;
    if (normalizedText.includes(encodedTarget)) {
      return { matches: true, hasExplicitEmail: true };
    }
  }

  const emails = extractEmails(text);
  if (!emails.length) {
    return { matches: false, hasExplicitEmail: false };
  }

  return {
    matches: emails.some((email) => emailMatchesTarget(email, normalizedTarget)),
    hasExplicitEmail: true,
  };
}

function parseGmailTimestamp(timeText) {
  const normalized = normalizeText(timeText);
  if (!normalized) return null;

  let match = normalized.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:周.|星期.)?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0
    ).getTime();
  }

  match = normalized.match(/(\d{1,2})月(\d{1,2})日(?:周.|星期.)?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      Number(match[1]) - 1,
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      0,
      0
    ).getTime();
  }

  match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(match[1]),
      Number(match[2]),
      0,
      0
    ).getTime();
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractVerificationCode(text) {
  const normalized = String(text || '');

  const cnMatch = normalized.match(/(?:验证码|代码)[^0-9]{0,16}(\d{6})/i);
  if (cnMatch) return cnMatch[1];

  const enMatch = normalized.match(/(?:verification\s+code|temporary\s+verification\s+code|your\s+chatgpt\s+code|code(?:\s+is)?)[^0-9]{0,16}(\d{6})/i);
  if (enMatch) return enMatch[1];

  const plainMatch = normalized.match(/\b(\d{6})\b/);
  if (plainMatch) return plainMatch[1];

  return null;
}

function rowMatchesFilters(preview, senderFilters, subjectFilters) {
  const senderText = normalizeText(preview.sender).toLowerCase();
  const subjectText = normalizeText(preview.subject).toLowerCase();
  const combinedText = normalizeText(preview.combinedText).toLowerCase();

  const senderMatch = senderFilters.some((filter) => {
    const value = String(filter || '').toLowerCase();
    return value && (senderText.includes(value) || combinedText.includes(value));
  });

  const subjectMatch = subjectFilters.some((filter) => {
    const value = String(filter || '').toLowerCase();
    return value && (subjectText.includes(value) || combinedText.includes(value));
  });

  return senderMatch || subjectMatch;
}

async function openThreadRow(row) {
  simulateClick(row);
  await sleep(1200);
  return normalizeText(document.body?.innerText || document.body?.textContent || '');
}

async function ensureInboxReady(step) {
  if (!/#inbox/i.test(location.href)) {
    const inboxLink = findInboxLink();
    if (inboxLink) {
      simulateClick(inboxLink);
      await sleep(800);
      log(`步骤 ${step}：已切回 Gmail 收件箱。`);
    } else {
      location.hash = '#inbox';
      await sleep(800);
    }
  }

  for (let i = 0; i < 20; i++) {
    const rows = collectThreadRows();
    if (rows.length > 0) {
      return rows;
    }
    await sleep(400);
  }

  return [];
}

async function refreshInbox(step) {
  const refreshButton = findRefreshButton();
  if (refreshButton) {
    simulateClick(refreshButton);
    log(`步骤 ${step}：已点击 Gmail 刷新。`);
    await sleep(1500);
    return;
  }

  const inboxLink = findInboxLink();
  if (inboxLink) {
    simulateClick(inboxLink);
    log(`步骤 ${step}：未找到刷新按钮，已重新进入收件箱。`);
    await sleep(1200);
    return;
  }

  location.reload();
  log(`步骤 ${step}：未找到刷新按钮，已直接刷新页面。`);
  await sleep(2500);
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 5,
    intervalMs = 3000,
    filterAfterTimestamp = 0,
    excludeCodes = [],
    targetEmail = '',
  } = payload || {};

  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));
  const inspectedMailIds = new Set();
  const filterAfterMinute = normalizeMinuteTimestamp(Number(filterAfterTimestamp) || 0);

  log(`步骤 ${step}：开始轮询 Gmail（最多 ${maxAttempts} 次）`);
  if (filterAfterMinute) {
    log(`步骤 ${step}：仅尝试 ${new Date(filterAfterMinute).toLocaleString('zh-CN', { hour12: false })} 及之后时间的邮件。`);
  }

  let rows = await ensureInboxReady(step);
  if (!rows.length) {
    await refreshInbox(step);
    rows = await ensureInboxReady(step);
  }

  if (!rows.length) {
    throw new Error('Gmail 收件箱列表未加载完成，请确认当前已打开 Gmail 收件箱。');
  }

  const existingMailIds = new Set(rows.map((row, index) => getRowFingerprint(row, index)));
  log(`步骤 ${step}：邮件列表已加载，共 ${rows.length} 封邮件`);
  log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 封旧邮件快照`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    log(`步骤 ${step}：正在轮询 Gmail，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshInbox(step);
    }

    rows = collectThreadRows();
    const useFallback = attempt > FALLBACK_AFTER;
    let index = 0;

    while (index < rows.length) {
      throwIfStopped();
      const row = rows[index];
      const rowId = getRowFingerprint(row, index);
      const preview = getRowPreviewText(row);
      const mailTimestamp = parseGmailTimestamp(preview.timeText);
      const mailMinute = normalizeMinuteTimestamp(mailTimestamp || 0);
      const passesTimeFilter = !filterAfterMinute || (mailMinute && mailMinute >= filterAfterMinute);
      const shouldBypassOldSnapshot = Boolean(filterAfterMinute && passesTimeFilter && mailMinute > 0);

      if (!passesTimeFilter) {
        index += 1;
        continue;
      }

      if (!useFallback && !shouldBypassOldSnapshot && existingMailIds.has(rowId)) {
        index += 1;
        continue;
      }

      if (!rowMatchesFilters(preview, senderFilters, subjectFilters)) {
        index += 1;
        continue;
      }

      const previewTargetState = getTargetEmailMatchState(preview.combinedText, targetEmail);
      const previewEmails = extractEmails(preview.combinedText);
      if (targetEmail && previewEmails.length > 0 && !previewTargetState.matches) {
        index += 1;
        continue;
      }

      const code = extractVerificationCode(preview.combinedText);
      if (code && previewTargetState.matches) {
        if (excludedCodeSet.has(code)) {
          log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
          index += 1;
          continue;
        }

        const source = useFallback && existingMailIds.has(rowId) ? '回退匹配邮件' : '新邮件';
        const timeLabel = mailTimestamp ? `，时间：${new Date(mailTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
        log(`步骤 ${step}：已在 Gmail 找到验证码：${code}（来源：${source}${timeLabel}，主题：${preview.subject.slice(0, 40)}）`, 'ok');
        return {
          ok: true,
          code,
          emailTimestamp: mailTimestamp || Date.now(),
          mailId: rowId,
        };
      }

      if (inspectedMailIds.has(rowId)) {
        index += 1;
        continue;
      }

      inspectedMailIds.add(rowId);
      const openedText = await openThreadRow(row);
      const openedTargetState = getTargetEmailMatchState(openedText, targetEmail);
      if (targetEmail && openedTargetState.hasExplicitEmail && !openedTargetState.matches) {
        rows = await ensureInboxReady(step);
        index = 0;
        continue;
      }

      const openedCode = extractVerificationCode(openedText);
      if (openedCode) {
        if (excludedCodeSet.has(openedCode)) {
          log(`步骤 ${step}：跳过排除的验证码：${openedCode}`, 'info');
          rows = await ensureInboxReady(step);
          index = 0;
          continue;
        }

        const source = useFallback && existingMailIds.has(rowId) ? '回退匹配邮件正文' : '新邮件正文';
        const timeLabel = mailTimestamp ? `，时间：${new Date(mailTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
        log(`步骤 ${step}：已在 Gmail 邮件正文中找到验证码：${openedCode}（来源：${source}${timeLabel}）`, 'ok');
        return {
          ok: true,
          code: openedCode,
          emailTimestamp: mailTimestamp || Date.now(),
          mailId: rowId,
        };
      }

      rows = await ensureInboxReady(step);
      index = 0;
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`步骤 ${step}：连续 ${FALLBACK_AFTER} 次未发现新邮件，开始回退到较早的匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      throwIfStopped();
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 Gmail 中找到新的匹配邮件。请手动检查 Gmail 收件箱。`
  );
}

}
