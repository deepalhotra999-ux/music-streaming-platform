// Phase 5 — shared jest setup: mock native-dependent modules so component
// tests run in the jest-expo environment without native code.

// expo-audio is a native module; component tests never drive real audio.
// The playback engine's own tests inject a fake driver instead.
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    replace: jest.fn(),
    remove: jest.fn(),
  })),
  setAudioModeAsync: jest.fn(async () => {}),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

// Vector icons pull in expo-font/expo-asset native deps in tests; a stub keeps
// component tests focused on UI structure.
jest.mock('@expo/vector-icons', () => {
  const Stub = () => null;
  return {
    __esModule: true,
    Ionicons: Stub,
    MaterialIcons: Stub,
    default: Stub,
  };
});

jest.mock('expo-router', () => {  const React = require('react');
  const routerMock = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
  // Mutable route segments for tests that assert navigation-dependent UI.
  const mockSegments = [];
  return {
    __esModule: true,
    __mockSegments: mockSegments,
    Link: ({ asChild, children }) =>
      asChild ? children : React.createElement(React.Fragment, null, children),
    Stack: { Screen: () => null },
    router: routerMock,
    useRouter: () => routerMock,
    useNavigation: () => ({ setOptions: jest.fn(), goBack: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useSegments: () => mockSegments,
    usePathname: () => '/',
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const inset = { top: 0, left: 0, right: 0, bottom: 0 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaConsumer: ({ children }) => children(inset),
    SafeAreaView: ({ children, style }) => React.createElement(View, { style }, children),
    useSafeAreaInsets: () => inset,
    initialWindowMetrics: {
      insets: inset,
      frame: { x: 0, y: 0, width: 0, height: 0 },
    },
  };
});
