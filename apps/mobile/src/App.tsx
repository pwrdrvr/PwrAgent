import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { canonicalDurableTurnRequest, canonicalDurableSteerRequest } from "../../../packages/shared/src/durable-turn-request";
import { mobileThreadKey, type MobileCredential, type MobilePage, type MobileSnapshot, type MobileThread } from "../../../packages/shared/src/mobile-gateway";
import { Gateway } from "./gateway";
import { Outbox, type OutboxEntry, type Receipt } from "./outbox";
import { credentials, outboxStorage } from "./storage";
import { LiveVoice } from "./live";
import { theme as t } from "./theme";
import { demoThreads } from "./demo";
import notices from "../assets/licenses.json";

function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[s.button, disabled && s.disabled]}><Text style={s.buttonText}>{title}</Text></Pressable>;
}
function Main() {
  const [credential, setCredential] = useState<MobileCredential>();
  const [status, setStatus] = useState("Offline");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [demo, setDemo] = useState(false);
  const [licenses, setLicenses] = useState(false);
  const [query, setQuery] = useState("");
  const [machine, setMachine] = useState<string>();
  const [threads, setThreads] = useState<MobileThread[]>([]);
  const [page, setPage] = useState<MobilePage>();
  const [selected, setSelected] = useState<MobileThread>();
  const [snapshot, setSnapshot] = useState<MobileSnapshot>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [liveStatus, setLiveStatus] = useState("Live off");
  const [liveText, setLiveText] = useState("");
  const gateway = useRef<Gateway | undefined>(undefined);
  const voice = useRef<LiveVoice | undefined>(undefined);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const queryRef = useRef(query); queryRef.current = query;
  const machineRef = useRef(machine); machineRef.current = machine;
  const refreshVersion = useRef(0);
  const outbox = useRef(new Outbox(outboxStorage, Crypto.randomUUID, async (target, request, createdAt, operation) => {
    const clientRequest = { version: 1 as const, createdAt };
    const canonical = operation === "steerTurn"
      ? canonicalDurableSteerRequest(target.instanceId, { clientRequest, request: { ...request, expectedTurnId: request.expectedTurnId! } })
      : canonicalDurableTurnRequest(target.instanceId, { clientRequest, request });
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
  }));
  useEffect(() => {
    const open = (url: string | null) => { if (url === "pwragent-mobile://demo") setDemo(true); };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", ({ url }) => open(url));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    void Promise.all([credentials.read(), outbox.current.load()]).then(([stored]) => {
      setCredential(stored); setEntries([...outbox.current.entries]); setStorageReady(true);
    }).catch((cause) => setError(String(cause)));
  }, []);
  const readSelected = useCallback(async (before?: string) => {
    const client = gateway.current; const current = selectedRef.current;
    if (!client?.hello || !current) return;
    const result = await client.rpc<MobileSnapshot>("thread", { target: current.target, before });
    if (selectedRef.current && mobileThreadKey(selectedRef.current.target) === mobileThreadKey(result.target)) {
      setSnapshot((previous) => before && previous ? { ...result, response: { ...result.response, replay: { ...result.response.replay,
        entries: [...result.response.replay.entries, ...previous.response.replay.entries.filter((entry) => !result.response.replay.entries.some((row) => row.id === entry.id))] } } } : result);
    }
  }, []);
  const refresh = useCallback(async (cursors?: Record<string, string>) => {
    const client = gateway.current; if (!client?.hello) return;
    const version = ++refreshVersion.current;
    const result = await client.rpc<MobilePage>("threads", { query: queryRef.current, machine: machineRef.current, cursors });
    if (version !== refreshVersion.current) return;
    if (result.machines && client.hello) client.hello.machines = result.machines;
    setPage(result);
    setThreads((previous) => {
      const rows = cursors ? [...previous, ...result.threads] : result.threads;
      return [...new Map(rows.map((thread) => [mobileThreadKey(thread.target), thread])).values()];
    });
  }, []);
  const reconcile = useCallback(async () => {
    const client = gateway.current; if (!client?.hello) return;
    for (const entry of [...outbox.current.entries]) {
      if (entry.gatewayId !== client.credential.gatewayId || entry.deviceId !== client.credential.deviceId || entry.state === "completed") continue;
      if (!client.hello.machines.find((row) => row.id === entry.target.instanceId)?.[entry.operation === "steerTurn" ? "canSteer" : "canSend"]) continue;
      const operation = entry.operation === "steerTurn" ? "steer" : "turn";
      const receipt = await client.rpc<Receipt | null>(`${operation}.get`, { target: entry.target, id: entry.id });
      if (receipt) await outbox.current.reconcile(receipt);
      else if (entry.state === "pending") await outbox.current.deliver(entry, (value) => client.rpc(`${operation}.submit`, {
        target: value.target, submission: { clientRequest: { version: 1, id: value.id, createdAt: value.createdAt, payloadHash: value.payloadHash }, request: value.request },
      }));
    }
    setEntries([...outbox.current.entries]);
  }, []);
  useEffect(() => {
    if (!credential || demo) return;
    // React Native supports the third WebSocket argument for native headers.
    const client = new Gateway(credential, (endpoint, token) => new (WebSocket as unknown as { new(url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket })(endpoint, [], { headers: { Authorization: `Bearer ${token}` } }));
    gateway.current = client;
    const live = new LiveVoice(client); voice.current = live;
    live.onStatus = setLiveStatus; live.onText = setLiveText;
    let updating = false; let dirty = false; let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (disposed) return;
      if (updating) { dirty = true; return; }
      updating = true;
      void (async () => {
        try { await refresh(); await Promise.all([reconcile(), readSelected()]); }
        catch (cause) { if (!disposed) setError(String(cause)); }
        finally { timer = setTimeout(() => { updating = false; if (dirty) { dirty = false; update(); } }, 300); }
      })();
    };
    client.onState = (state) => {
      setStatus(state);
      if (state === "Connected") { setError(""); update(); }
      else if (state !== "Connecting") void live.stop();
    };
    client.onEvent = (event) => { live.event(event); if (event.event === "changed") update(); };
    client.connect();
    const lifecycle = AppState.addEventListener("change", (state) => {
      if (state === "active") client.connect();
      else { void live.stop(); client.stop(); }
    });
    return () => { disposed = true; clearTimeout(timer); lifecycle.remove(); void live.stop(); client.stop(); gateway.current = undefined; voice.current = undefined; };
  }, [credential, demo, readSelected, reconcile, refresh]);
  useEffect(() => { const timer = setTimeout(() => { void refresh().catch((cause) => setError(String(cause))); }, 250); return () => clearTimeout(timer); }, [query, machine, refresh]);
  useEffect(() => { setSnapshot(undefined); setDraft(""); void readSelected().catch((cause) => setError(String(cause))); }, [selected, readSelected]);
  const pair = async () => {
    setBusy(true); setError("");
    try {
      const endpoint = new URL(url.trim());
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Enter your gateway HTTPS address.");
      const response = await fetch(`${endpoint.origin}/mobile/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), name: Platform.OS === "ios" ? "My iPhone" : "My Android" }) });
      if (!response.ok) throw new Error("Pairing code expired, used, or invalid.");
      const value = { ...await response.json(), url: endpoint.origin } as MobileCredential;
      await credentials.write(value); setCode(""); setCredential(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pairing failed"); }
    finally { setBusy(false); }
  };
  const send = async (expectedTurnId?: string) => {
    if (!selected || !credential || busy) return;
    setBusy(true); setError("");
    try {
      await outbox.current.enqueue(selected.target, draft, credential, expectedTurnId);
      setEntries([...outbox.current.entries]); setDraft(""); await reconcile();
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const visible = (demo ? demoThreads : threads).filter((thread) => (!machine || thread.target.instanceId === machine)
    && (!demo || thread.row.title.toLowerCase().includes(query.toLowerCase())));
  const machineRows = demo ? demoThreads.map((row) => ({ id: row.target.instanceId, label: row.machineLabel })) : gateway.current?.hello?.machines ?? [];
  const canSend = storageReady && !demo && selected && gateway.current?.hello?.scopes.includes("send") && gateway.current.hello.machines.find((row) => row.id === selected.target.instanceId)?.canSend;
  const latestTurn = snapshot?.response.replay.entries.flatMap((entry) => "turn" in entry && entry.turn ? [entry.turn] : []).at(-1);
  const activeTurnId = latestTurn?.status === "in_progress" ? latestTurn.id : undefined;
  const canSteer = canSend && activeTurnId && gateway.current?.hello?.machines.find((row) => row.id === selected?.target.instanceId)?.canSteer;
  const pending = selected ? entries.filter((entry) => mobileThreadKey(entry.target) === mobileThreadKey(selected.target)
    && entry.gatewayId === credential?.gatewayId && entry.deviceId === credential.deviceId) : [];
  return <SafeAreaView style={s.safe}>
    <StatusBar barStyle="light-content" />
    <View style={s.header}><Text style={s.brand}>PWR<Text style={s.accent}>AGENT</Text></Text><Text style={s.caption}>{demo ? "DEMO · INVENTED DATA" : status.toUpperCase()}</Text></View>
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {licenses ? <ScrollView contentContainerStyle={s.transcript}><Button title="‹ Back" onPress={() => setLicenses(false)} /><Text style={s.title}>Open-source licenses</Text>{[...notices.packages, ...notices.native].map((notice, index) => <View key={index}><Text style={s.label}>{notice.name}</Text><Text selectable style={s.activity}>{notice.text}</Text></View>)}</ScrollView> : !credential && !demo ? <View key="pair" style={s.pair}>
      <Text style={s.hero}>Your threads.{"\n"}Every machine.</Text><Text style={s.subtitle}>Pair with your trusted PwrAgent gateway.</Text>
      <Text style={s.label}>GATEWAY</Text><TextInput accessibilityLabel="Gateway HTTPS address" placeholder="https://gateway.example.com:9443" placeholderTextColor={t.muted} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={s.input} />
      <Text style={s.label}>ONE-TIME PAIRING CODE</Text><TextInput accessibilityLabel="One-time pairing code" secureTextEntry value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} style={s.input} />
      <Button title={busy ? "Pairing…" : "Pair this phone"} onPress={() => { void pair(); }} disabled={busy || !url || !code} />
      <Button title="Open-source licenses" onPress={() => setLicenses(true)} />
      <Button title="Explore demo" onPress={() => { setError(""); setDemo(true); }} />
    </View> : selected ? <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.detailHeader}><Button title="‹ Threads" onPress={() => setSelected(undefined)} /><Text style={s.title}>{selected.row.title}</Text><Text style={s.caption}>{selected.machineLabel} · {selected.target.backend}</Text></View>
      <ScrollView style={s.flex} contentContainerStyle={s.transcript}>
        {snapshot?.response.replay.pagination.hasPreviousPage && <Button title="Earlier activity" onPress={() => { void readSelected(snapshot.response.replay.pagination.previousCursor).catch((cause) => setError(String(cause))); }} />}
        {demo ? <><Text style={s.label}>YOU</Text><Text style={s.body}>Bring the dashboard together and check the small-screen layout.</Text><Text style={s.label}>PWRAGENT</Text><Text style={s.body}>The dashboard is ready for review. The layout adapts to your phone, and the focused checks passed.</Text><Text style={s.activity}>✓ Layout checks complete · 3 files updated</Text></> : snapshot?.response.replay.entries.map((entry) => entry.type === "message"
          ? <View key={entry.id} style={s.message}><Text style={s.label}>{entry.role === "user" ? "YOU" : "PWRAGENT"}</Text><Text selectable style={s.body}>{entry.text}</Text></View>
          : <Text key={entry.id} style={s.activity}>{entry.type === "activity" ? entry.summary : "Activity updated"}</Text>)}
        {pending.map((entry) => <View key={entry.id} style={s.receipt}><Text style={s.caption}>{entry.operation === "steerTurn" ? "STEER · " : ""}{entry.state.toUpperCase()} · {entry.id.slice(0, 8)}</Text>
          {/* Only the authoritative transcript renders prompt text. Even an
              uncertain receipt cannot produce a second local message echo. */}
          {!!entry.error && <Text style={s.error}>{entry.error}</Text>}
          {entry.state === "uncertain" && <Text style={s.body}>The gateway cannot confirm dispatch. Check the thread before sending a new request.</Text>}
          {entry.state === "pending" && <Button title="Check delivery" onPress={() => { void reconcile().catch((cause) => setError(String(cause))); }} />}
        </View>)}
      </ScrollView>
      <View style={s.composer}><TextInput accessibilityLabel="Message" placeholder="Send a new turn…" placeholderTextColor={t.muted} multiline maxLength={16_000} value={draft} onChangeText={setDraft} style={[s.input, s.draft]} /><Button title="Steer" disabled={!canSteer || !draft.trim() || busy} onPress={() => { void send(activeTurnId); }} /><Button title="Send" disabled={!canSend || !draft.trim() || busy} onPress={() => { void send(); }} /></View>
    </KeyboardAvoidingView> : <View key="threads" style={s.flex}>
      <View style={s.toolbar}><Text style={s.hero}>Threads</Text><Text style={s.subtitle}>Across your connected machines</Text><TextInput accessibilityLabel="Search all threads" secureTextEntry={false} autoCapitalize="none" autoCorrect={false} placeholder="Search all threads" placeholderTextColor={t.muted} value={query} onChangeText={setQuery} style={s.input} /></View>
      <ScrollView horizontal style={s.filters} contentContainerStyle={s.filterContent}><Button title="All machines" onPress={() => setMachine(undefined)} disabled={!machine} />{machineRows.map((row) => <Button key={row.id} title={row.label} onPress={() => setMachine(row.id)} disabled={machine === row.id} />)}</ScrollView>
      {!!page && Object.entries(page.errors).map(([id, message]) => <Text key={id} style={s.error}>{machineRows.find((row) => row.id === id)?.label ?? id}: {message}</Text>)}
      <FlatList data={visible} keyExtractor={(item) => mobileThreadKey(item.target)} renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => setSelected(item)} style={s.row}>
        <Text style={s.caption}>{item.machineLabel.toUpperCase()} · {item.target.backend.toUpperCase()}</Text><Text style={s.rowTitle}>{item.row.title}</Text><Text style={s.subtitle}>{item.row.projectKey?.split("/").pop() ?? "Thread"} <Text style={s.accent}>· {item.row.threadStatus ?? "idle"}</Text></Text>
      </Pressable>} ListEmptyComponent={<Text style={s.empty}>{status === "Connected" ? "No matching threads" : "Connect to see your threads"}</Text>} ListFooterComponent={page && Object.keys(page.cursors).length ? <Button title="Load more" onPress={() => { void refresh(page.cursors).catch((cause) => setError(String(cause))); }} /> : null} />
      <View style={s.live}><View style={s.liveHeader}><View style={s.flex}><Text style={s.title}>GPT Live</Text><Text style={s.subtitle}>{liveStatus}</Text></View><Button title={liveStatus === "Live" || liveStatus === "Connecting Live" ? "End Live" : "Start Live"} disabled={demo || !gateway.current?.hello?.scopes.includes("voice")} onPress={() => { void (liveStatus === "Live" || liveStatus === "Connecting Live" ? voice.current?.stop() : voice.current?.start()); }} /></View>{!!liveText && <Text numberOfLines={3} style={s.body}>{liveText}</Text>}</View>
      <View style={s.footer}><Button title="Open-source licenses" onPress={() => setLicenses(true)} /><Button title={demo ? "Exit demo" : "Disconnect phone"} onPress={() => { if (demo) setDemo(false); else { void credentials.clear().then(() => setCredential(undefined)); } }} /></View>
    </View>}
  </SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><Main /></SafeAreaProvider>; }
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.background }, flex: { flex: 1 }, header: { paddingHorizontal: 22, paddingVertical: 16, borderBottomWidth: 1, borderColor: t.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { color: t.text, fontSize: 18, fontWeight: "800", letterSpacing: 1 }, accent: { color: t.accent }, caption: { color: t.muted, fontSize: 10, fontWeight: "600", letterSpacing: 0.8 },
  pair: { padding: 24, gap: 14 }, hero: { color: t.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 }, subtitle: { color: t.secondary, fontSize: 13, lineHeight: 20 }, label: { color: t.accent, fontSize: 10, fontWeight: "700", letterSpacing: 1.3, marginTop: 12, marginBottom: 6 },
  input: { color: t.text, backgroundColor: t.input, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 14, fontSize: 16 }, button: { paddingHorizontal: 14, paddingVertical: 12, backgroundColor: t.elevated, borderRadius: 8, borderWidth: 1, borderColor: t.border }, buttonText: { color: t.accent, fontWeight: "600", fontSize: 14 }, disabled: { opacity: 0.4 },
  toolbar: { padding: 22, gap: 9 }, filters: { height: 60, flexGrow: 0, flexShrink: 0 }, filterContent: { paddingHorizontal: 22, gap: 8, alignItems: "center", paddingBottom: 8 }, row: { paddingHorizontal: 22, paddingVertical: 20, borderBottomWidth: 1, borderColor: t.border, gap: 7 }, rowTitle: { color: t.text, fontSize: 19, fontWeight: "600", lineHeight: 25 }, empty: { color: t.secondary, padding: 24 },
  live: { padding: 20, marginHorizontal: 20, backgroundColor: t.panel, borderWidth: 1, borderColor: t.border, borderRadius: 8, gap: 8 }, title: { color: t.text, fontSize: 20, fontWeight: "600" }, liveHeader: { flexDirection: "row", alignItems: "center", gap: 12 }, footer: { padding: 16, flexDirection: "row", justifyContent: "space-between", gap: 8 }, error: { color: t.danger, padding: 12, fontSize: 13 }, detailHeader: { padding: 18, gap: 8 }, transcript: { padding: 22, gap: 12 }, message: { gap: 5 }, body: { color: t.text, fontSize: 16, lineHeight: 24 }, activity: { color: t.secondary, fontSize: 12, paddingVertical: 8 }, receipt: { borderLeftWidth: 2, borderColor: t.accent, padding: 12, gap: 6 }, composer: { padding: 14, borderTopWidth: 1, borderColor: t.border, flexDirection: "row", alignItems: "flex-end", gap: 10 }, draft: { flex: 1, maxHeight: 140 },
});
