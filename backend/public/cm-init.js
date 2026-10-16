// Initialize CodeMirror 5 and register it with the shared query editor helpers.
(function() {
  function init() {
    const textarea = document.getElementById('queryEditor');
    if (!textarea) return;

    // If CodeMirror wasn't loaded, do nothing.
    if (typeof CodeMirror === 'undefined') {
      console.warn('CodeMirror not found; leaving plain textarea in place.');
      return;
    }

    const height = parseInt(getComputedStyle(textarea).height, 10) || 192;
    // fromTextArea hides the original textarea itself.
    const editor = CodeMirror.fromTextArea(textarea, {
      mode: 'text/x-sql',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
      indentWithTabs: false,
      tabSize: 2,
      extraKeys: {
        'Ctrl-Enter': function(cm) { triggerExecute(); },
        'Cmd-Enter': function(cm) { triggerExecute(); }
      }
    });

    QueryEditor.codeMirror = editor;

    // Keep the textarea synchronized for the fallback and native form behavior.
    editor.on('change', function(cm) {
      cm.save();
    });

    // It starts inside the hidden login view; connect() refreshes it when shown.
    editor.setSize('100%', height);

    // Keep a global reference for debugging if needed
    window._cm_queryEditor = editor;

    function triggerExecute() {
      const btn = document.getElementById('executeBtn');
      if (btn) btn.click();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
