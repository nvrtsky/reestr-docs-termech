import { useCallback, useEffect, useRef } from 'react';

import './app.css';
import { getRegistryBitrixContext } from './bitrix-context';
import { selectCrmEntities } from './bitrix-crm-selector';

export function App() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sendContext = useCallback(async (refresh = false) => {
    const context = await getRegistryBitrixContext(refresh);
    frameRef.current?.contentWindow?.postMessage(
      { type: 'registry-bitrix-context', context },
      window.location.origin,
    );
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frameRef.current?.contentWindow
      ) return;
      if (event.data?.type === 'registry-bitrix-context-request') {
        void sendContext(event.data.refresh === true);
        return;
      }
      if (event.data?.type === 'registry-bitrix-select-crm-request') {
        const requestId = event.data.requestId;
        const value = event.data.value || { deal: [], company: [] };
        void selectCrmEntities(value)
          .then((items) => frameRef.current?.contentWindow?.postMessage(
            { type: 'registry-bitrix-select-crm-response', requestId, items },
            window.location.origin,
          ))
          .catch((error: unknown) => frameRef.current?.contentWindow?.postMessage(
            {
              type: 'registry-bitrix-select-crm-response',
              requestId,
              error: error instanceof Error ? error.message : 'Bitrix24 CRM selector failed.',
            },
            window.location.origin,
          ));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sendContext]);

  return (
    <iframe
      ref={frameRef}
      className="legacy-registry"
      src="/legacy/index.html"
      title="Реестр документов"
      onLoad={() => void sendContext(false)}
    />
  );
}
