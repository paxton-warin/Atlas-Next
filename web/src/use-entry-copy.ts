import { useEffect, useState } from "react";

/** Delay only busy copy, never a result, recovery control, or navigation. */
export function useEntryCopy(pending: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, [pending]);
  return !pending || visible;
}
