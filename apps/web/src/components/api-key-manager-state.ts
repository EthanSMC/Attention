export interface ApiKeyRow {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  name: string;
  needsRotation: boolean;
  status: "active" | "revoked";
}

export interface ApiKeyManagerState {
  busy: boolean;
  error: string | null;
  modal: "closed" | "naming" | "revealed";
  name: string;
  rows: ApiKeyRow[];
  secret: string | null;
  uncertain: boolean;
}

export type ApiKeyManagerAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "change_name"; value: string }
  | { type: "create_started" }
  | { type: "create_failed"; message: string }
  | { type: "create_unknown"; message: string }
  | { type: "create_succeeded"; row: ApiKeyRow; secret: string }
  | { type: "revoke_succeeded"; id: string };

export function createApiKeyManagerState(rows: ApiKeyRow[]): ApiKeyManagerState {
  return {
    busy: false,
    error: null,
    modal: "closed",
    name: "",
    rows,
    secret: null,
    uncertain: false,
  };
}

export function apiKeyManagerReducer(
  state: ApiKeyManagerState,
  action: ApiKeyManagerAction,
): ApiKeyManagerState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        busy: false,
        error: null,
        modal: "naming",
        name: "",
        secret: null,
        uncertain: false,
      };
    case "close":
      return {
        ...state,
        busy: false,
        error: null,
        modal: "closed",
        name: "",
        secret: null,
        uncertain: false,
      };
    case "change_name":
      return { ...state, error: null, name: action.value };
    case "create_started":
      return { ...state, busy: true, error: null, uncertain: false };
    case "create_failed":
      return {
        ...state,
        busy: false,
        error: action.message,
        modal: "naming",
        secret: null,
        uncertain: false,
      };
    case "create_unknown":
      return {
        ...state,
        busy: false,
        error: action.message,
        modal: "naming",
        secret: null,
        uncertain: true,
      };
    case "create_succeeded":
      return {
        ...state,
        busy: false,
        error: null,
        modal: "revealed",
        rows: [action.row, ...state.rows],
        secret: action.secret,
        uncertain: false,
      };
    case "revoke_succeeded":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, status: "revoked" } : row,
        ),
      };
  }
}
