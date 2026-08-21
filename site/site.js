/* Amlak — public site motion.
 *
 * The whole site was zero-JS until now and this file is the only script on it:
 * no framework, no scroll library, nothing fetched. Petra Labs (the reference
 * George sent) runs the same effects on Framer's runtime; everything here is
 * ~120 lines of plain DOM because a marketing site that ships a scroll engine
 * to animate four lines has spent the visitor's bandwidth on itself.
 *
 * ⚠ THE FAILURE MODE IS THE WHOLE DESIGN. The usual way to build scroll-reveal
 * is to hide everything in CSS and un-hide it from JS — which means one script
 * error, one blocked file, one browser with JS off, and the page is BLANK. So
 * nothing here is hidden by the stylesheet. This file adds the class that hides
 * an element a moment before it reveals it, and the flow diagram's `--p`
 * defaults to 1 (fully drawn) in CSS and is only pulled back to 0 once this
 * script has committed to driving it. Every effect below degrades to "the
 * finished state, no motion" — never to "nothing".
 *
 * ⚠ AND `prefers-reduced-motion` IS CHECKED HERE, NOT ONLY IN CSS. A media
 * query can switch a transition off, but it cannot stop a scroll listener from
 * running on every frame. When the visitor has asked for less motion this file
 * wires up nothing at all and leaves the page in its finished state.
 */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── the nav lifts off the page once it has something under it ────────
     The nav is already `position:sticky`; this only tells you it is floating
     over content rather than sitting on the paper. */
  var nav = document.querySelector('.nav');
  if (nav) {
    var stuck = function () { nav.classList.toggle('stuck', window.scrollY > 8); };
    stuck();
    window.addEventListener('scroll', stuck, { passive: true });
  }

  if (reduce) return;

  /* ── scroll reveal ────────────────────────────────────────────────────
     Selected here rather than marked up with a `data-reveal` attribute on
     every block of every page: nine pages of hand-placed attributes drift
     apart the moment someone adds a section and forgets one, and the whole
     effect is "the major blocks of a marketing page", which is a selector.
     ⚠ `.legal-wrap` is excluded deliberately — a privacy policy whose
     paragraphs fade in as you read down it is a policy that is harder to
     read, which is the opposite of why it exists. */
  var REVEAL = '.section-head, .cards .card, .feature-copy, .feature-art,' +
               ' .cta, .tl-item, .cmp-card, .form-card, .flow-figure, .stat-row';

  var targets = [];
  Array.prototype.forEach.call(document.querySelectorAll(REVEAL), function (el) {
    if (el.closest('.legal-wrap')) return;
    // ⚠ ONLY WHAT IS STILL BELOW THE FOLD. Hiding an element that is already
    // on screen and revealing it on the next frame is a visible flash — the
    // one bug this pattern always ships with. Anything the visitor can
    // already see is simply left alone.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
    el.classList.add('rv');
    targets.push(el);
  });

  if (targets.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    targets.forEach(function (el) { io.observe(el); });
  } else {
    // No observer (very old browser): show everything rather than nothing.
    targets.forEach(function (el) { el.classList.add('in'); });
  }

  /* ── the pinned flow diagram ──────────────────────────────────────────
     One sticky panel inside a tall track, with scroll position through the
     track expressed as `--p` (0 → 1) and the stylesheet doing the rest with
     calc(). That is the same mechanism Petra Labs' attribution section uses —
     a single `position:sticky` child with the scroll distance around it —
     minus the runtime that normally comes with it.
     ⚠ Below 680px the pin is switched OFF in CSS (`position:static`), because
     three screen-heights of scrolling that move nothing on a phone reads as a
     broken page. So the driver bails there too and leaves `--p` at its CSS
     default of 1: the diagram is simply drawn, complete, and scrolls past. */
  var flow = document.querySelector('.flow');
  var track = flow && flow.querySelector('.flow-track');
  var pin = flow && flow.querySelector('.flow-pin');
  var phone = window.matchMedia('(max-width:680px)');

  if (flow && track && pin) {
    var raf = 0;

    var update = function () {
      raf = 0;
      if (!flow.classList.contains('pinned')) return;
      var box = track.getBoundingClientRect();
      var travel = box.height - pin.offsetHeight;
      // ⚠ THE STICKY OFFSET IS PART OF THE SUM. The pin latches when its top
      // reaches `top:var(--navh)`, not when it reaches 0, so measuring from
      // the viewport top starts the drawing a nav's height late — the first
      // 70px of pinned scrolling would sit at p=0 doing nothing. Read the
      // offset off the element rather than hard-coding 70: --navh is 112 once
      // the nav wraps to two rows.
      var stick = parseFloat(getComputedStyle(pin).top) || 0;
      var p = travel > 0 ? (stick - box.top) / travel : 1;
      p = p < 0 ? 0 : p > 1 ? 1 : p;

      flow.style.setProperty('--p', p.toFixed(4));
      // The caption is a step function over the same progress, so the words
      // and the drawing can never disagree about which stage this is.
      flow.setAttribute('data-stage', p < 0.28 ? '0' : p < 0.52 ? '1' : p < 0.78 ? '2' : '3');
    };

    var schedule = function () { if (!raf) raf = requestAnimationFrame(update); };

    // `.pinned` is the switch: the stylesheet gives the track its three screens
    // of height and the panel its `position:sticky` only while this class is
    // on. Turning it off has to put the diagram back to FINISHED, not to
    // whatever `--p` happened to be when the window was last resized narrow.
    var setMode = function () {
      if (phone.matches) {
        flow.classList.remove('pinned');
        flow.style.removeProperty('--p');    // back to the CSS default: drawn
        flow.setAttribute('data-stage', '3');
      } else {
        flow.classList.add('pinned');
        update();
      }
    };

    setMode();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', setMode);
  }
})();
