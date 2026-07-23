import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk';

export interface RegistryBitrixContext {
  auth: {
    accessToken: string;
    domain: string;
    memberId: string;
  } | null;
  placement: {
    code: string;
    title: string;
    options: unknown;
    isSliderMode: boolean;
  } | null;
}

let framePromise: Promise<B24Frame | null> | null = null;

async function getFrame() {
  if (window.self === window.top) return null;
  if (!framePromise) {
    framePromise = initializeB24Frame().catch(() => null);
  }
  return framePromise;
}

export async function getRegistryBitrixContext(refresh = false): Promise<RegistryBitrixContext> {
  const frame = await getFrame();
  if (!frame) return { auth: null, placement: null };
  if (refresh) await frame.auth.refreshAuth();
  const auth = frame.auth.getAuthData();
  return {
    auth: auth
      ? {
          accessToken: auth.access_token,
          domain: auth.domain,
          memberId: auth.member_id,
        }
      : null,
    placement: {
      code: frame.placement.placement,
      title: frame.placement.title,
      options: frame.placement.options,
      isSliderMode: frame.placement.isSliderMode,
    },
  };
}
