// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Testing Library's waitFor defaults to 1 second. Most render tests here don't await
// a repaint — they await a real WRITE CHAIN through the demo mock (save → update →
// resync the year's invoice and its marked months → read it back), and vitest runs
// the suite's files in parallel threads. Past ~128 files that 1s became marginal on a
// loaded machine, and a handful of unrelated tests began failing perhaps one run in
// seven — always reporting the pre-write value, which reads as a WRONG FIGURE rather
// than a slow one. That is the worst kind of red: it accuses the money math.
//
// Five seconds is still far below anything a genuine hang would need, so a real
// regression fails just as loudly, just as fast. Behaviour is unchanged; only the
// patience is.
configure({ asyncUtilTimeout: 5000 });
