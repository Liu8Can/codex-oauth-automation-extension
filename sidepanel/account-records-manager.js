(function attachSidepanelAccountRecordsManager(globalScope) {
  function createAccountRecordsManager(context = {}) {
    const {
      state,
      dom,
      helpers,
      runtime,
      constants = {},
    } = context;

    const displayTimeZone = constants.displayTimeZone || 'Asia/Shanghai';
    const pageSize = Math.max(1, Math.floor(Number(constants.pageSize) || 10));

    let currentPage = 1;

    function escapeHtml(value) {
      if (typeof helpers.escapeHtml === 'function') {
        return helpers.escapeHtml(String(value || ''));
      }
      return String(value || '');
    }

    function normalizeTimestamp(value) {
      const timestamp = Date.parse(String(value || ''));
      return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function getAccountRunRecords(currentState = state.getLatestState()) {
      return (Array.isArray(currentState?.accountRunHistory) ? currentState.accountRunHistory : [])
        .filter((item) => item && typeof item === 'object')
        .slice()
        .sort((left, right) => normalizeTimestamp(right.finishedAt) - normalizeTimestamp(left.finishedAt));
    }

    function summarizeAccountRunHistory(records = []) {
      return records.reduce((summary, record) => {
        summary.total += 1;
        if (record.finalStatus === 'success') {
          summary.success += 1;
        } else if (record.finalStatus === 'failed') {
          summary.failed += 1;
        } else if (record.finalStatus === 'stopped') {
          summary.stopped += 1;
        }
        summary.retryTotal += Math.max(0, Math.floor(Number(record.retryCount) || 0));
        return summary;
      }, {
        total: 0,
        success: 0,
        failed: 0,
        stopped: 0,
        retryTotal: 0,
      });
    }

    function formatAccountRecordTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return '--:--';
      }

      const now = new Date();
      const sameYear = date.getFullYear() == now.getFullYear();
      const sameDay = date.toDateString() === now.toDateString();

      if (sameDay) {
        return date.toLocaleTimeString('zh-CN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          timeZone: displayTimeZone,
        });
      }

      return date.toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        ...(sameYear ? {} : { year: '2-digit' }),
        timeZone: displayTimeZone,
      }).replace(/\//g, '-');
    }

    function getStatusMeta(record = {}) {
      if (record.finalStatus === 'success') {
        return { kind: 'success', label: '成功' };
      }
      if (record.finalStatus === 'stopped') {
        return { kind: 'stopped', label: '停止' };
      }
      return { kind: 'failed', label: '失败' };
    }

    function getRecordSummaryText(record = {}) {
      if (record.finalStatus === 'success') {
        return '流程完成';
      }

      return String(record.failureLabel || '').trim() || '流程失败';
    }

    function createStatChip(label, value, className = '') {
      return `<span class="account-records-stat${className ? ` ${className}` : ''}"><strong>${escapeHtml(String(value))}</strong>${escapeHtml(label)}</span>`;
    }

    function updateHeader(records) {
      if (!dom.accountRecordsMeta || !dom.accountRecordsStats) {
        return;
      }

      if (!records.length) {
        dom.accountRecordsMeta.textContent = '暂无邮箱记录';
      } else {
        dom.accountRecordsMeta.textContent = `共 ${records.length} 条，最近更新于 ${formatAccountRecordTime(records[0]?.finishedAt)}`;
      }

      const summary = summarizeAccountRunHistory(records);
      dom.accountRecordsStats.innerHTML = [
        createStatChip('总', summary.total),
        createStatChip('成', summary.success, 'is-success'),
        createStatChip('失', summary.failed, 'is-failed'),
        createStatChip('停', summary.stopped, 'is-stopped'),
        createStatChip('重试', summary.retryTotal, 'is-retry'),
      ].join('');
    }

    function updatePagination(totalRecords) {
      const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 0;
      if (totalPages === 0) {
        currentPage = 1;
      } else if (currentPage > totalPages) {
        currentPage = totalPages;
      } else if (currentPage < 1) {
        currentPage = 1;
      }

      if (dom.accountRecordsPageLabel) {
        dom.accountRecordsPageLabel.textContent = totalPages > 0 ? `${currentPage} / ${totalPages}` : '0 / 0';
      }
      if (dom.btnAccountRecordsPrev) {
        dom.btnAccountRecordsPrev.disabled = totalPages <= 1 || currentPage <= 1;
      }
      if (dom.btnAccountRecordsNext) {
        dom.btnAccountRecordsNext.disabled = totalPages <= 1 || currentPage >= totalPages;
      }
      if (dom.btnClearAccountRecords) {
        dom.btnClearAccountRecords.disabled = totalRecords === 0;
      }

      return totalPages;
    }

    function renderRecordList(records = []) {
      if (!dom.accountRecordsList) {
        return;
      }

      const totalPages = updatePagination(records.length);
      if (!records.length) {
        dom.accountRecordsList.innerHTML = '<div class="account-records-empty">暂无邮箱记录。</div>';
        return;
      }

      const startIndex = (currentPage - 1) * pageSize;
      const visibleRecords = records.slice(startIndex, startIndex + pageSize);

      dom.accountRecordsList.innerHTML = visibleRecords.map((record) => {
        const statusMeta = getStatusMeta(record);
        const summaryText = getRecordSummaryText(record);
        const retryCount = Math.max(0, Math.floor(Number(record.retryCount) || 0));
        return `
          <div class="account-record-item is-${escapeHtml(statusMeta.kind)}" title="${escapeHtml(String(record.email || ''))}">
            <div class="account-record-item-top">
              <div class="account-record-item-email mono">${escapeHtml(String(record.email || '').trim() || '(空邮箱)')}</div>
              <div class="account-record-item-side">
                <span class="account-record-item-status">${escapeHtml(statusMeta.label)}</span>
                <span class="account-record-item-time mono">${escapeHtml(formatAccountRecordTime(record.finishedAt))}</span>
              </div>
            </div>
            <div class="account-record-item-bottom">
              <div class="account-record-item-summary">${escapeHtml(summaryText)}</div>
              <span class="account-record-item-retry mono">重试 ${escapeHtml(String(retryCount))}</span>
            </div>
          </div>
        `;
      }).join('');

      if (totalPages <= 1 && dom.accountRecordsPageLabel) {
        dom.accountRecordsPageLabel.textContent = '1 / 1';
      }
    }

    function render(currentState = state.getLatestState()) {
      const records = getAccountRunRecords(currentState);
      updateHeader(records);
      renderRecordList(records);
    }

    function openPanel() {
      if (dom.accountRecordsOverlay) {
        dom.accountRecordsOverlay.hidden = false;
      }
      render();
    }

    function closePanel() {
      if (dom.accountRecordsOverlay) {
        dom.accountRecordsOverlay.hidden = true;
      }
    }

    async function clearRecords() {
      const records = getAccountRunRecords();
      if (!records.length) {
        helpers.showToast?.('没有可清理的邮箱记录。', 'warn', 1800);
        return;
      }

      const confirmed = await helpers.openConfirmModal({
        title: '清理邮箱记录',
        message: '确认清理当前全部邮箱记录吗？该操作会同时清空面板记录与本地同步快照。',
        confirmLabel: '确认清理',
        confirmVariant: 'btn-danger',
      });
      if (!confirmed) {
        return;
      }

      const response = await runtime.sendMessage({
        type: 'CLEAR_ACCOUNT_RUN_HISTORY',
        source: 'sidepanel',
      });
      if (response?.error) {
        throw new Error(response.error);
      }

      currentPage = 1;
      state.syncLatestState({ accountRunHistory: [] });
      helpers.showToast?.(`已清理 ${Math.max(0, Number(response?.clearedCount) || 0)} 条邮箱记录`, 'success', 2200);
    }

    function bindEvents() {
      dom.btnOpenAccountRecords?.addEventListener('click', () => {
        openPanel();
      });
      dom.btnCloseAccountRecords?.addEventListener('click', () => {
        closePanel();
      });
      dom.accountRecordsOverlay?.addEventListener('click', (event) => {
        if (event.target === dom.accountRecordsOverlay) {
          closePanel();
        }
      });
      dom.btnAccountRecordsPrev?.addEventListener('click', () => {
        if (currentPage <= 1) {
          return;
        }
        currentPage -= 1;
        render();
      });
      dom.btnAccountRecordsNext?.addEventListener('click', () => {
        currentPage += 1;
        render();
      });
      dom.btnClearAccountRecords?.addEventListener('click', () => {
        clearRecords().catch((error) => {
          helpers.showToast?.(`清理邮箱记录失败：${error.message}`, 'error');
        });
      });
    }

    function reset() {
      currentPage = 1;
      closePanel();
      render();
    }

    return {
      bindEvents,
      closePanel,
      openPanel,
      render,
      reset,
      summarizeAccountRunHistory,
    };
  }

  globalScope.SidepanelAccountRecordsManager = {
    createAccountRecordsManager,
  };
})(typeof window !== 'undefined' ? window : globalThis);
