(function () {
  const results = [];

  function record(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail || '' });
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function runGmail() {
    const gmailBody = document.querySelector('#gmail-compose .Am.Al.editable');
    if (!gmailBody) return Promise.resolve();

    const gmailBtns = document.querySelectorAll('#gmail-compose .renzo-generate-btn');
    const gmailBar = document.querySelector('#gmail-compose .renzo-compose-bar');
    const sendRow = document.querySelector('#gmail-compose .btC');
    const bodyCell = document.querySelector('#gmail-compose td.I5');

    record('gmail: generate button is injected', gmailBtns.length >= 1, 'count=' + gmailBtns.length);
    record(
      'gmail: button is not inside the native send toolbar',
      gmailBtns.length > 0 && ![...gmailBtns].some((b) => sendRow && sendRow.contains(b)),
      gmailBtns.length ? 'insideSend=' + [...gmailBtns].some((b) => sendRow && sendRow.contains(b)) : 'no button'
    );
    record(
      'gmail: button lives in its own compose bar block',
      !!(gmailBar && gmailBtns[0] && gmailBar.contains(gmailBtns[0])),
      gmailBar ? 'bar present' : 'missing .renzo-compose-bar'
    );
    record(
      'gmail: button is not a raw sibling mashed into the message-body cell',
      !(bodyCell && [...gmailBtns].some((b) => bodyCell.contains(b))),
      bodyCell && gmailBtns[0] ? 'inI5=' + bodyCell.contains(gmailBtns[0]) : 'n/a'
    );

    if (gmailBtns[0] && gmailBody) {
      const cloned = gmailBtns[0].cloneNode(true);
      gmailBtns[0].parentElement.replaceChild(cloned, gmailBtns[0]);
      click(cloned);
    }

    return wait(50).then(function () {
      const filledGmail = (gmailBody && (gmailBody.textContent || '').indexOf('reconnect') !== -1);
      record(
        'gmail: click generates outreach text even after host clones the button',
        filledGmail,
        gmailBody ? JSON.stringify(gmailBody.textContent) : 'no body'
      );
      let payload = {};
      try { payload = JSON.parse(window.__renzoLastFetch && window.__renzoLastFetch.opts && window.__renzoLastFetch.opts.body || '{}'); } catch (e) {}
      record(
        'gmail: request uses the compose recipient, not the page heading',
        payload.contactName === 'Alex Rivera' && payload.context === 'Gmail compose',
        JSON.stringify(payload)
      );
    });
  }

  function runLinkedIn() {
    const classicBody = document.querySelector('#linkedin-classic .msg-form__contenteditable');
    if (!classicBody && !document.getElementById('linkedin-new')) return Promise.resolve();

    const classicBtns = document.querySelectorAll('#linkedin-classic .renzo-generate-btn');
    const classicRow = document.querySelector('#linkedin-classic .msg-form__row');
    const classicBar = document.querySelector('#linkedin-classic .renzo-compose-bar');

    record(
      'linkedin-classic: button injected for ellipsis aria-label compose',
      classicBtns.length >= 1,
      'count=' + classicBtns.length
    );
    record(
      'linkedin-classic: button is not a flex sibling of Send in the input row',
      classicBtns.length > 0 && ![...classicBtns].some((b) => classicRow && classicRow.contains(b) && !b.closest('.renzo-compose-bar')),
      classicBtns.length ? 'inRow=' + [...classicBtns].some((b) => classicRow && classicRow.contains(b)) : 'no button'
    );
    record(
      'linkedin-classic: button lives in its own compose bar block',
      !!(classicBar && classicBtns[0] && classicBar.contains(classicBtns[0])),
      classicBar ? 'bar present' : 'missing .renzo-compose-bar'
    );

    const newBtns = document.querySelectorAll('#linkedin-new .renzo-generate-btn');
    record(
      'linkedin-new: button injected without msg-form class',
      newBtns.length >= 1,
      'count=' + newBtns.length
    );

    if (classicBtns[0] && classicBody) {
      click(classicBtns[0]);
    }

    return wait(50).then(function () {
      const filledLi = classicBody && (classicBody.textContent || '').indexOf('reconnect') !== -1;
      record(
        'linkedin: click generates outreach text in the message box',
        filledLi,
        classicBody ? JSON.stringify(classicBody.textContent) : 'no body'
      );
      let payload = {};
      try { payload = JSON.parse(window.__renzoLastFetch && window.__renzoLastFetch.opts && window.__renzoLastFetch.opts.body || '{}'); } catch (e) {}
      record(
        'linkedin: request uses the conversation name, not the page heading',
        payload.contactName === 'Jordan Lee' && payload.context === 'LinkedIn message',
        JSON.stringify(payload)
      );
    });
  }

  function runReinjection() {
    document.querySelectorAll('.renzo-compose-bar').forEach(function (el) { el.remove(); });
    if (window.RenzoExtension && window.RenzoExtension.scan) {
      window.RenzoExtension.scan(document.body);
    }
    return wait(80).then(function () {
      const host = (location.hostname || '').includes('linkedin') ? '#linkedin-classic' : '#gmail-compose';
      record(
        're-inject: button returns after host removes it',
        document.querySelectorAll(host + ' .renzo-generate-btn').length >= 1,
        'count=' + document.querySelectorAll(host + ' .renzo-generate-btn').length
      );
    });
  }

  function finish() {
    const failed = results.filter(function (r) { return !r.pass; });
    const summary = {
      passed: results.filter(function (r) { return r.pass; }).length,
      failed: failed.length,
      results: results
    };
    const el = document.getElementById('renzo-test-results');
    el.textContent = JSON.stringify(summary, null, 2);
    document.title = failed.length ? 'RENZO_FAIL' : 'RENZO_PASS';
    document.body.dataset.renzoTest = failed.length ? 'fail' : 'pass';
  }

  function run() {
    Promise.resolve()
      .then(runGmail)
      .then(runLinkedIn)
      .then(runReinjection)
      .then(finish)
      .catch(function (err) {
        document.getElementById('renzo-test-results').textContent = String(err && err.stack || err);
        document.title = 'RENZO_FAIL';
        document.body.dataset.renzoTest = 'fail';
      });
  }

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();
