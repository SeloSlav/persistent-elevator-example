import { DbConnection } from './module_bindings';
import type { ElevatorState, InputState, PlayerState } from '../shared/simulation';

export type PlayerReplica = PlayerState & { slot: number; online: boolean; sampleMicros: bigint; identity: { toHexString(): string } };
export class Network {
  connection?: DbConnection;
  identity = '';
  players = new Map<string, PlayerReplica>();
  elevator?: ElevatorState;
  elevatorReceivedAt = 0;
  revision = 0;
  status = 'Connecting to SpacetimeDB…';
  error = '';
  ready = false;
  private stopped = false;
  private hasSeat = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private tokenKey = `elevator-guest:${import.meta.env.VITE_SPACETIMEDB_DATABASE ?? 'persistent-elevator-example'}`;

  connect() {
    this.status = 'Connecting to SpacetimeDB…';
    this.connection = DbConnection.builder()
      .withUri(import.meta.env.VITE_SPACETIMEDB_URI ?? 'http://127.0.0.1:3001')
      .withDatabaseName(import.meta.env.VITE_SPACETIMEDB_DATABASE ?? 'persistent-elevator-example')
      .withToken(sessionStorage.getItem(this.tokenKey) ?? undefined)
      .onConnect((connection, identity, token) => {
        this.identity = identity.toHexString();
        this.hasSeat = false;
        sessionStorage.setItem(this.tokenKey, token);
        this.error = '';
        const syncPlayers = () => {
          const before = this.players.get(this.identity);
          this.players.clear();
          for (const row of connection.db.player.iter()) this.players.set(row.identity.toHexString(), row);
          const after = this.players.get(this.identity);
          if (before?.sampleMicros !== after?.sampleMicros || before?.online !== after?.online) this.revision++;
        };
        const syncElevator = () => {
          const row = [...connection.db.elevator.iter()][0];
          if (row) {
            this.elevator = { ...structuredClone(row), queue: Array.from(row.queue), landingOpen: Array.from(row.landingOpen) };
            this.elevatorReceivedAt = performance.now();
          }
        };
        connection.db.player.onInsert(syncPlayers);
        connection.db.player.onUpdate(syncPlayers);
        connection.db.player.onDelete(syncPlayers);
        connection.db.elevator.onInsert(syncElevator);
        connection.db.elevator.onUpdate(syncElevator);
        connection.subscriptionBuilder()
          .onApplied(() => {
            syncPlayers(); syncElevator();
            this.ready = true;
            this.status = 'Connected';
            this.join();
          })
          .onError(ctx => { this.error = String(ctx.event); this.status = 'Subscription failed'; })
          .subscribe(['SELECT * FROM player', 'SELECT * FROM elevator']);
      })
      .onConnectError((_ctx, error) => { this.error = String(error); this.scheduleReconnect(); })
      .onDisconnect((_ctx, error) => {
        this.ready = false;
        this.hasSeat = false;
        this.players.clear();
        this.elevator = undefined;
        if (error) this.error = String(error);
        this.scheduleReconnect();
      })
      .build();
  }

  get local() { return this.hasSeat ? this.players.get(this.identity) : undefined; }
  get count() { return [...this.players.values()].filter(p => p.online).length; }
  join() {
    if (!this.ready) return;
    this.connection!.reducers.join({}).then(() => { this.hasSeat = true; this.revision++; this.error = ''; }).catch(error => {
      this.error = error instanceof Error ? error.message : String(error);
      // Duplicate Tab may copy sessionStorage. Give that second tab its own guest.
      if (this.error.includes('already open in another connection')) {
        sessionStorage.removeItem(this.tokenKey);
        this.connection?.disconnect();
      }
    });
  }
  input(input: InputState) {
    if (this.ready && this.local?.online) this.act(() => this.connection!.reducers.submitInput(input), true);
  }
  floor(floor: number) { this.act(() => this.connection!.reducers.selectFloor({ floor })); }
  hail(floor: number) { this.act(() => this.connection!.reducers.hailFloor({ floor })); }
  landingDoor(floor: number) { this.act(() => this.connection!.reducers.toggleLandingDoor({ floor })); }
  door(open: boolean) { this.act(() => this.connection!.reducers.setDoorOpen({ open })); }
  respawn() { this.act(() => this.connection!.reducers.respawn({})); }
  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.connection?.disconnect();
  }
  private act(action: () => Promise<unknown>, quiet = false) {
    if (!this.ready) return;
    action().catch(error => {
      if (!quiet) { this.error = error instanceof Error ? error.message : String(error); }
    });
  }
  private scheduleReconnect() {
    this.status = 'Reconnecting…';
    this.ready = false;
    if (!this.stopped && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, 2000);
    }
  }
}
