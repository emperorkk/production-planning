/* DragDropManager — HTML5 drag+drop for unscheduled cards and gantt blocks,
   plus mousedown-based resize handles.
   Events emitted via callbacks registered on DragDropManager.on(event, fn). */
(function (global) {
  'use strict';

  var _callbacks  = {};
  var _ganttScroll = null;   // #gantt-scroll element
  var _dropGhost   = null;   // #drop-ghost element

  // Current drag state
  var _drag = {
    active:    false,
    type:      null,     // 'new' | 'move'
    orderId:   null,
    phaseNo:   null,
    machineId: null,     // for moves
    durationHours: null,
    sourceEl:  null
  };

  // Current resize state
  var _resize = {
    active:    false,
    blockEl:   null,
    orderId:   null,
    phaseNo:   null,
    machineId: null,
    origWidth: 0,
    startX:    0,
    minWidth:  GanttRenderer ? GanttRenderer.pxPerHour() * 0.5 : 20   // 30-min min
  };

  // ── Public API ─────────────────────────────────────────────────────────────
  var DragDropManager = {

    on: function (event, fn) { _callbacks[event] = fn; },

    init: function (ganttScrollEl, dropGhostEl) {
      _ganttScroll = ganttScrollEl;
      _dropGhost   = dropGhostEl;
      _attachGanttListeners();
    },

    // Call after re-render to re-attach block listeners
    attachBlockListeners: function () {
      var blocks = _ganttScroll.querySelectorAll('.gantt-block');
      blocks.forEach(_attachBlockListeners);
    },

    // Call to re-attach listeners to unscheduled panel cards
    attachCardListeners: function () {
      var cards = document.querySelectorAll('.order-card[draggable], .phase-pill[draggable]');
      cards.forEach(function (el) {
        el.addEventListener('dragstart', _onCardDragStart);
      });
    }
  };

  // ── Unscheduled card drag ──────────────────────────────────────────────────
  function _onCardDragStart(e) {
    var orderId  = e.currentTarget.dataset.orderId;
    var phaseNo  = parseInt(e.currentTarget.dataset.phaseNo, 10);

    _drag.active       = true;
    _drag.type         = 'new';
    _drag.orderId      = orderId;
    _drag.phaseNo      = phaseNo;
    _drag.durationHours = null;   // computed on dragover from target machine
    _drag.sourceEl     = e.currentTarget;

    e.currentTarget.classList.add('dragging');

    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', orderId + '|' + phaseNo);
    _emit('dragStart', _drag);
  }

  // ── Gantt block listeners ─────────────────────────────────────────────────
  function _attachBlockListeners(el) {
    var resizeHandle = el.querySelector('.resize-handle');

    // Drag block (move)
    el.addEventListener('dragstart', function (e) {
      e.stopPropagation();
      _drag.active        = true;
      _drag.type          = 'move';
      _drag.orderId       = el.dataset.orderId;
      _drag.phaseNo       = parseInt(el.dataset.phaseNo, 10);
      _drag.machineId     = el.dataset.machineId;
      // Capture the actual block width so we preserve duration during a same-machine move
      _drag.durationHours = el.offsetWidth / GanttRenderer.pxPerHour();
      _drag.sourceEl      = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'move');
      _emit('dragStart', _drag);
    });

    el.addEventListener('dragend', function () {
      el.classList.remove('dragging');
      _drag.active = false;
      _hideGhost();
    });

    // Right-click context menu
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      _emit('contextMenu', {
        x: e.clientX, y: e.clientY,
        orderId: el.dataset.orderId,
        phaseNo: parseInt(el.dataset.phaseNo, 10),
        machineId: el.dataset.machineId
      });
    });

    // Resize handle
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        _resize.active    = true;
        _resize.blockEl   = el;
        _resize.orderId   = el.dataset.orderId;
        _resize.phaseNo   = parseInt(el.dataset.phaseNo, 10);
        _resize.machineId = el.dataset.machineId;
        _resize.origWidth = el.offsetWidth;
        _resize.startX    = e.clientX;
        _emit('resizeStart', _resize);
        document.addEventListener('mousemove', _onResizeMove);
        document.addEventListener('mouseup',   _onResizeEnd);
      });

      // Prevent drag from triggering resize zone clicks
      resizeHandle.addEventListener('dragstart', function (e) { e.stopPropagation(); e.preventDefault(); });
    }
  }

  // ── Resize handlers ────────────────────────────────────────────────────────
  function _onResizeMove(e) {
    if (!_resize.active) return;
    var dx = e.clientX - _resize.startX;
    var newWidth = Math.max(_resize.minWidth, _resize.origWidth + dx);
    _resize.blockEl.style.width = newWidth + 'px';
    _emit('resizeMove', { resize: _resize, newWidth: newWidth });
  }

  function _onResizeEnd(e) {
    if (!_resize.active) return;
    document.removeEventListener('mousemove', _onResizeMove);
    document.removeEventListener('mouseup',   _onResizeEnd);

    var dx = e.clientX - _resize.startX;
    var newWidth    = Math.max(_resize.minWidth, _resize.origWidth + dx);
    var pxPerHour   = GanttRenderer.pxPerHour();
    var rawHours    = newWidth / pxPerHour;
    // Snap to nearest 0.5h
    var hours = Math.max(0.5, Math.round(rawHours * 2) / 2);
    var snappedWidth = hours * pxPerHour;
    _resize.blockEl.style.width = snappedWidth + 'px';

    _emit('resizeEnd', {
      orderId:      _resize.orderId,
      phaseNo:      _resize.phaseNo,
      machineId:    _resize.machineId,
      durationHours: hours
    });
    _resize.active = false;
  }

  // ── Gantt timeline drag-over and drop ─────────────────────────────────────
  function _attachGanttListeners() {
    _ganttScroll.addEventListener('dragover', _onGanttDragOver);
    _ganttScroll.addEventListener('dragleave', _onGanttDragLeave);
    _ganttScroll.addEventListener('drop', _onGanttDrop);
    _ganttScroll.addEventListener('dragend', function () {
      _cleanDragOverStyles();
      _hideGhost();
      _drag.active = false;
    });
  }

  function _getTimelineFromEvent(e) {
    var el = e.target;
    while (el && el !== _ganttScroll) {
      if (el.classList && el.classList.contains('gantt-timeline')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function _onGanttDragOver(e) {
    if (!_drag.active) return;
    var tl = _getTimelineFromEvent(e);
    if (!tl) { _cleanDragOverStyles(); _hideGhost(); return; }

    var phase = tl.dataset.phase;

    // Validate the order can drop onto this machine (phase eligibility checked downstream)
    if (!_emit('validateDrop', { phase: phase, machineId: tl.dataset.machineId, drag: _drag })) {
      e.dataTransfer.dropEffect = 'none';
      _cleanDragOverStyles(); _hideGhost(); return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = _drag.type === 'move' ? 'move' : 'copy';

    _cleanDragOverStyles();
    tl.classList.add('drag-over');

    // Live duration based on chosen target machine
    var liveHours = _callbacks.computeDuration ? _callbacks.computeDuration({
      orderId:   _drag.orderId,
      phaseNo:   _drag.phaseNo,
      machineId: tl.dataset.machineId,
      type:      _drag.type,
      preserveExisting: _drag.type === 'move' && _drag.machineId === tl.dataset.machineId
    }) : (_drag.durationHours || 1);
    _drag.durationHours = liveHours;

    // Compute proposed time from mouse x
    var rect  = tl.getBoundingClientRect();
    var relX  = e.clientX - rect.left + _ganttScroll.scrollLeft - GanttRenderer.LABEL_WIDTH;
    relX = Math.max(0, relX);
    var proposedStart = GanttRenderer.snapDate(GanttRenderer.xToDate(relX));
    var durationMs    = liveHours * 3600000;
    var proposedEnd   = new Date(proposedStart.getTime() + durationMs);

    // Show ghost
    var ghostX = GanttRenderer.dateToX(proposedStart) + GanttRenderer.LABEL_WIDTH;
    var ghostW = liveHours * GanttRenderer.pxPerHour();
    var tlRect = tl.getBoundingClientRect();
    var scrollRect = _ganttScroll.getBoundingClientRect();

    _dropGhost.style.display = 'block';
    _dropGhost.style.left    = (ghostX - _ganttScroll.scrollLeft + scrollRect.left) + 'px';
    _dropGhost.style.top     = (tlRect.top - scrollRect.top + 4) + 'px';
    _dropGhost.style.width   = ghostW + 'px';
    _dropGhost.style.height  = (GanttRenderer.ROW_HEIGHT - 8) + 'px';

    _emit('dragOver', {
      machineId: tl.dataset.machineId,
      phase:     phase,
      proposedStart: proposedStart,
      proposedEnd:   proposedEnd,
      drag: _drag
    });
  }

  function _onGanttDragLeave(e) {
    if (!_ganttScroll.contains(e.relatedTarget)) {
      _cleanDragOverStyles(); _hideGhost();
    }
  }

  function _onGanttDrop(e) {
    if (!_drag.active) return;
    var tl = _getTimelineFromEvent(e);
    if (!tl) { _drag.active = false; return; }

    var phase = tl.dataset.phase;
    if (!_emit('validateDrop', { phase: phase, machineId: tl.dataset.machineId, drag: _drag })) {
      _drag.active = false; return;
    }

    e.preventDefault();
    _cleanDragOverStyles();
    _hideGhost();

    var rect  = tl.getBoundingClientRect();
    var relX  = e.clientX - rect.left + _ganttScroll.scrollLeft - GanttRenderer.LABEL_WIDTH;
    relX = Math.max(0, relX);
    var proposedStart = GanttRenderer.snapDate(GanttRenderer.xToDate(relX));

    // Re-compute duration on the actual drop machine (in case mouse moved between bands)
    var dropHours = _callbacks.computeDuration ? _callbacks.computeDuration({
      orderId:   _drag.orderId,
      phaseNo:   _drag.phaseNo,
      machineId: tl.dataset.machineId,
      type:      _drag.type,
      preserveExisting: _drag.type === 'move' && _drag.machineId === tl.dataset.machineId
    }) : (_drag.durationHours || 1);

    var durationMs    = dropHours * 3600000;
    var proposedEnd   = new Date(proposedStart.getTime() + durationMs);

    _emit('drop', {
      type:         _drag.type,
      orderId:      _drag.orderId,
      machineId:    tl.dataset.machineId,
      phase:        phase,
      plannedStart: proposedStart,
      plannedEnd:   proposedEnd,
      durationHours: dropHours,
      previousMachineId: _drag.machineId
    });

    if (_drag.sourceEl) _drag.sourceEl.classList.remove('dragging');
    _drag.active = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _cleanDragOverStyles() {
    var els = _ganttScroll.querySelectorAll('.drag-over');
    els.forEach(function (el) { el.classList.remove('drag-over'); });
  }

  function _hideGhost() {
    if (_dropGhost) _dropGhost.style.display = 'none';
  }

  function _emit(event, data) {
    if (_callbacks[event]) return _callbacks[event](data);
    return true;   // default: allow
  }

  global.DragDropManager = DragDropManager;

})(window);
