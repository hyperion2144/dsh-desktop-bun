import { useRef } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { palette } from '../theme';
import type { EnterTarget } from './HomeScreen';
import { useSessionGuard } from '../lib/use-session-guard';
import { useRemotePorts } from '../lib/use-remote-ports';
import { useRemoteSession } from '../lib/use-remote-session';
import { SessionOverlay } from '../lib/session-overlay';
import { emptyState, entryPathOf, entryPlaceholderUrl } from '../lib/remote-entry';
import { appDistCache } from '../lib/expo-file-port';

export interface AndroidBackRefs {
  /** WebView 内部历史能否后退（onNavigationStateChange 更新） */
  canGoBack: { current: boolean };
  /** 让 WebView 后退一步 */
  goBack: { current: () => void };
}

export function WebScreen({ target, onBack, androidBackRefs }: {
  target: EnterTarget;
  onBack: () => void;
  androidBackRefs?: AndroidBackRefs;
}) {
  const webRef = useRef<WebView>(null);
  // #144 会话守卫：回前台/网络换代 → 探针 → 页面内轻量重连优先；仅页面已无法执行脚本时才兜底重载。
  // #175：对端下发过守卫退避基数就按它算（0/缺省 → 本机 10s）。
  const guard = useSessionGuard(webRef, target.base, 'session-guard', target.guardBackoffBaseMs ?? 0);
  // #155：本地资产 + 远程数据。进页面前先跑一遍「换会话 → 检测远端版本 → 命中则起壳内 loopback 服务」。
  // 就绪前先占位；但**配对入口不能占位成它自己**——那个地址带一次性 token，WebView 一加载就把它
  // 用掉了，壳随后 /pair 换会话必然失败（手机端实测到的「配对失败」）。于是配对入口先停 about:blank。
  const entryPath = entryPathOf(target.url);
  const { ports, error: portsError } = useRemotePorts({
    base: target.base ?? null,
    entryPath,
    // #155：持久化缓存（文件端口 = expo-file-system）——冷启动直接读沙箱里那份前端产物，
    // 不再重下几 MB；缓存残缺时 dist-cache 会拒认并回落到下载。
    cache: appDistCache,
  });
  const { controller, state } = useRemoteSession({ ports, fallbackUrl: target.url });

  // 会话**种进 WebView 的 cookie jar**（对应桌面 `web_token`、鸿蒙 `plantCookie`）：
  // 页面靠自己发的请求就会带会话，不必每次都经壳代理；没有会话时保持 undefined。
  const sessionCookie = ports?.cookie ?? null;
  const cookieBootstrap = sessionCookie
    ? `try{document.cookie=${JSON.stringify(`${sessionCookie}; path=/`)};}catch(e){}`
    : undefined;
  // #195：占位**绝不裸连远端**——ports 未就绪时 sessionCookie 为 null，挂载即加载 target.url
  // 会以无 cookie 身份直连 lane（门禁 401 {"error":"unpaired"}，旧仓 #195 的指纹）；而三选一
  // 的 fallback URL 与占位相同，source 不变不重载，bootstrap 永远补不上。cookie 就绪后占位
  // 切到真实地址，source 变化触发重载、bootstrap 随导航注入（鸿蒙 #155 同一教训）。
  const placeholderUrl = entryPlaceholderUrl({ entryPath, sessionCookie, targetUrl: target.url });
  const pageUrl = state?.url ?? placeholderUrl;
  // 导航失败重试计数（成功导航后清零）；见 onError 注释。
  const navRetries = useRef(0);
  // iOS RNW 的 visitSource 对**无 host 的 URL**（about:blank / data:）会走 loadFileURL 抛
  // NSInvalidArgumentException（模拟器实测：配对入口占位即 SIGABRT）。占位改走静态 HTML
  // （loadHTMLString 分支），真实页面仍按 uri 加载。
  const webSource: { html: string } | { uri: string } =
    pageUrl === 'about:blank'
      ? { html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body></body></html>' }
      : { uri: pageUrl };
  // 占位（html）→ 真页面（uri）的 source 形态切换在 iOS 上不会自动重载：用 key 强制重建。

  const overlay = (
    <SessionOverlay
      state={portsError ? { ...emptyState, phase: 'error', reason: portsError } : state}
      onChoose={(choice) => void controller?.choose(choice)}
      onRetry={() => void controller?.start()}
    />
  );

  function onShouldStartLoadWithRequest(nav: WebViewNavigation): boolean {
    // 外链（既不是远端 base、也不是壳内 loopback 页面）交系统浏览器；应用内导航放行。
    try {
      const cur = new URL(nav.url);
      const want = new URL(target.url);
      // 壳内服务的 origin（127.0.0.1/localhost）是**我们自己**：首次加载就是从这个源开始的，
      // 只比 target.url 会把本地页面当成外链拦掉（模拟器实测：卡在占位白页，WebView 零导航）。
      const localHost = (() => {
        try {
          return state?.url ? new URL(state.url).host : '';
        } catch {
          return '';
        }
      })();
      const sameOrigin = cur.host === want.host || (localHost !== '' && cur.host === localHost);
      if (!sameOrigin && nav.navigationType === 'other') {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  // Android：系统手势返回（edge back）有效，不显示顶部栏，WebView 全屏。
  // iOS：返回手势无效，必须保留顶部返回栏（SafeAreaView 避让状态栏）。
  if (Platform.OS === 'android') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <WebView
          ref={webRef}
          key={pageUrl}
          source={webSource}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          style={{ flex: 1 }}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          originWhitelist={['*']}
          injectedJavaScriptBeforeContentLoaded={cookieBootstrap}
          onMessage={guard.onMessage}
          onRenderProcessGone={guard.onRenderProcessGone}
          onNavigationStateChange={(nav) => {
            if (androidBackRefs) {
              androidBackRefs.canGoBack.current = nav.canGoBack;
              androidBackRefs.goBack.current = () => webRef.current?.goBack();
            }
            if (nav.loading && nav.title && nav.title !== 'Webpage not available') navRetries.current = 0;
          }}
          onError={() => {
            // 壳内服务首个请求偶发落空（Android 曾见 ERR_EMPTY_RESPONSE）：自动退避重载，最多 3 次。
            if (navRetries.current < 3) {
              navRetries.current += 1;
              setTimeout(() => webRef.current?.reload(), 400 * navRetries.current);
            }
          }}
        />
        {overlay}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* iOS 必须保留顶部返回栏（返回手势无效）；RN 内置 SafeAreaView 在 iOS
          自动给顶部加安全区 padding，让返回按钮避开 iPad 状态栏。 */}
      <SafeAreaView style={styles.safeTop}>
        <View style={styles.bar}>
          <Pressable onPress={onBack} hitSlop={8}>
            <Text style={styles.back}>‹ 返回</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {target.name}
          </Text>
          <Pressable onPress={() => webRef.current?.reload()} hitSlop={8}>
            <Text style={styles.back}>⟳</Text>
          </Pressable>
        </View>
      </SafeAreaView>
      <WebView
        ref={webRef}
        key={pageUrl}
        source={webSource}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        style={{ flex: 1 }}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={cookieBootstrap}
        onMessage={guard.onMessage}

        onContentProcessDidTerminate={guard.onRenderProcessGone}
      />
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  safeTop: {
    backgroundColor: palette.panel,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: palette.panel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  back: {
    color: palette.accent,
    fontSize: 15,
  },
  title: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
    marginHorizontal: 8,
  },
});