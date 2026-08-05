import { useCallback, useEffect, useRef, useState } from 'react';

import './app.css';
import {
  getRegistryBitrixContext,
  validateRegistryBitrixApplication,
} from './bitrix-context';
import { openBitrixPath, selectCrmEntities } from './bitrix-crm-selector';

export function App() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [startup, setStartup] = useState<'loading' | 'ready' | 'error'>('loading');
  const [startupError, setStartupError] = useState('');
  const sendContext = useCallback(async (refresh = false) => {
    const context = await getRegistryBitrixContext(refresh);
    frameRef.current?.contentWindow?.postMessage(
      { type: 'registry-bitrix-context', context },
      window.location.origin,
    );
  }, []);

  useEffect(() => {
    let active = true;
    void validateRegistryBitrixApplication()
      .then(() => {
        if (active) setStartup('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStartupError(
          error instanceof Error
            ? error.message
            : 'Не удалось подключить приложение к Bitrix24.',
        );
        setStartup('error');
      });
    return () => {
      active = false;
    };
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
        const entityTypes = Array.isArray(event.data.entityTypes)
          ? event.data.entityTypes.filter((item: unknown) => item === 'deal' || item === 'company')
          : ['deal', 'company'];
        void selectCrmEntities(value, entityTypes, event.data.multiple !== false)
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
        return;
      }
      if (event.data?.type === 'registry-bitrix-open-path-request') {
        const requestId = event.data.requestId;
        void openBitrixPath(String(event.data.path || ''))
          .then(() => frameRef.current?.contentWindow?.postMessage(
            { type: 'registry-bitrix-open-path-response', requestId },
            window.location.origin,
          ))
          .catch((error: unknown) => frameRef.current?.contentWindow?.postMessage(
            {
              type: 'registry-bitrix-open-path-response',
              requestId,
              error: error instanceof Error ? error.message : 'Bitrix24 could not open the page.',
            },
            window.location.origin,
          ));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sendContext]);

  if (startup === 'loading') {
    return <div className="app-startup">Загружаем реестр...</div>;
  }
  if (startup === 'error') {
    return (
      <div className="app-startup app-startup-error">
        <strong>Не удалось подключить реестр</strong>
        <span>{startupError}</span>
        <button type="button" onClick={() => window.location.reload()}>
          Повторить
        </button>
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      className="legacy-registry"
      src={`${import.meta.env.BASE_URL}legacy/index.html${window.location.search || '?'}${window.location.search ? '&' : ''}v=${__LEGACY_APP_VERSION__}`}
      title="Реестр документов"
      onLoad={() => void sendContext(false)}
    />
  );
}
