import { createContext, useContext, useState, useEffect } from 'react';
import { currentYear } from '../lib/format';

// Holds the chrome state that the top bar renders on behalf of the current page:
// the breadcrumb trail and the (shared) fiscal-year selector.
const ChromeContext = createContext(null);

export function ChromeProvider({ children }) {
  const [crumbs, setCrumbs] = useState([]);
  const [year, setYear] = useState(currentYear());
  const [yearVisible, setYearVisible] = useState(false);
  return (
    <ChromeContext.Provider value={{ crumbs, setCrumbs, year, setYear, yearVisible, setYearVisible }}>
      {children}
    </ChromeContext.Provider>
  );
}

export function useChrome() {
  return useContext(ChromeContext);
}

// Pages call this to publish their breadcrumb + whether the FY selector shows.
// `crumbs` = [{ label, to? }] (last item is the current page).
export function usePageChrome(crumbs, showYear = false) {
  const { setCrumbs, setYearVisible } = useChrome();
  const key = JSON.stringify(crumbs) + '|' + showYear;
  useEffect(() => {
    setCrumbs(crumbs || []);
    setYearVisible(showYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
