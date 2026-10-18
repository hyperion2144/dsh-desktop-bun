import { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeScreen, type EnterTarget } from './src/screens/HomeScreen';
import { AddPairScreen } from './src/screens/AddPairScreen';
import { WebScreen, type AndroidBackRefs } from './src/screens/WebScreen';
import { addPair, setActive } from './src/store';
import { buildPairEntryUrl, type PairEntry } from './src/lib/pair';

export default function App() {
  const [target, setTarget] = useState<EnterTarget | null>(null);
  const [adding, setAdding] = useState(false);

  // Android 系统返回：WebView 内部能后退则退，否则回主页。
  const androidBackRefs = useRef<AndroidBackRefs>({
    canGoBack: { current: false },
    goBack: { current: () => {} },
  });

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (target) {
        // 优先 WebView 内部历史后退（dsh 页内导航），再回主页
        if (androidBackRefs.current.canGoBack.current) {
          androidBackRefs.current.goBack.current();
        } else {
          setTarget(null);
        }
        return true; // 拦截
      }
      return false; // 默认：退出
    });
    return () => sub.remove();
  }, [target]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {target ? (
        <WebScreen
          target={target}
          onBack={() => setTarget(null)}
          androidBackRefs={androidBackRefs.current}
        />
      ) : adding ? (
        <AddPairScreen
          onCancel={() => setAdding(false)}
          onDone={(p: PairEntry) => {
            addPair(p);
            setActive(p.base);
            setAdding(false);
            setTarget({ url: buildPairEntryUrl(p), base: p.base, name: p.name ?? p.base });
          }}
        />
      ) : (
        <HomeScreen onEnter={setTarget} onAdd={() => setAdding(true)} />
      )}
    </SafeAreaProvider>
  );
}
