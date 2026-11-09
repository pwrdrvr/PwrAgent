/** Handle-free profile identity persistence shared by the two hosts. */
export {
  startProfileRuntimeHeartbeat,
  findLiveProfileRuntimeMarkers,
  isProfileRuntimeIdentityLive,
  getProcessRuntimeIdentity,
  isProcessAlive,
  PROFILE_RUNTIME_HEARTBEAT_TTL_MS,
  type ProfileRuntimeHeartbeat,
  type ProfileRuntimeMarker,
  type ProfileRuntimeIdentity,
} from "@pwragent/sqlite-storage/profile-runtime-markers";
