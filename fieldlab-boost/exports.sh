# Dirty Boost Whore: built-in LND, fully separate from the "lightning" app.
export APP_BOOST_LND_IP="10.21.21.91"
export APP_BOOST_LND_REST_PORT="8080"   # container-internal only, not published
export APP_BOOST_LND_GRPC_PORT="10009"  # container-internal only, not published
export APP_BOOST_LND_DATA_DIR="${EXPORTS_APP_DIR}/data/lnd"
export APP_BOOST_NETWORK="${APP_BITCOIN_NETWORK:-mainnet}"

BIN_ARGS=()
BIN_ARGS+=( "--lnddir=/data/.lnd" )
BIN_ARGS+=( "--alias=node-7f3a" "--color=#808080" )
# No inbound at all: no P2P listener, no NAT/UPnP, no externalip, no hidden service.
BIN_ARGS+=( "--nolisten" )
BIN_ARGS+=( "--rpclisten=0.0.0.0:${APP_BOOST_LND_GRPC_PORT}" "--restlisten=0.0.0.0:${APP_BOOST_LND_REST_PORT}" )
BIN_ARGS+=( "--tlsextraip=${APP_BOOST_LND_IP}" )
# Auto-unlock flags are added by the lnd container's entrypoint (docker-compose.yml) ONLY when
# /data/.lnd/wallet-password exists: LND exits at startup if the flag points at a missing file
# (lnd config.go). The file is written by the web app at first-run setup (mode 600), never in the repo.

BIN_ARGS+=( "--bitcoin.active" )
case "${APP_BOOST_NETWORK}" in
  mainnet)  BIN_ARGS+=( "--bitcoin.mainnet" ) ;;
  testnet)  BIN_ARGS+=( "--bitcoin.testnet" ) ;;
  testnet4) BIN_ARGS+=( "--bitcoin.testnet4" ) ;;
  signet)   BIN_ARGS+=( "--bitcoin.signet" ) ;;
  regtest)  BIN_ARGS+=( "--bitcoin.regtest" ) ;;
  *) echo "Warning (${EXPORTS_APP_ID}): network '${APP_BOOST_NETWORK}' not supported" ;;
esac
BIN_ARGS+=( "--bitcoin.node=bitcoind" )
BIN_ARGS+=( "--bitcoind.rpchost=${APP_BITCOIN_NODE_IP}:${APP_BITCOIN_RPC_PORT}" )
BIN_ARGS+=( "--bitcoind.rpcuser=${APP_BITCOIN_RPC_USER}" "--bitcoind.rpcpass=${APP_BITCOIN_RPC_PASS}" )
BIN_ARGS+=( "--bitcoind.zmqpubrawblock=tcp://${APP_BITCOIN_NODE_IP}:${APP_BITCOIN_ZMQ_RAWBLOCK_PORT}" )
BIN_ARGS+=( "--bitcoind.zmqpubrawtx=tcp://${APP_BITCOIN_NODE_IP}:${APP_BITCOIN_ZMQ_RAWTX_PORT}" )

# Tor for OUTBOUND peer connections only, via umbrelOS's system Tor proxy
# (TOR_PROXY_IP/TOR_PROXY_PORT are set by umbrelOS app-script, 10.21.21.11:9050).
# No --tor.v3 / --tor.control => LND creates no hidden service.
BIN_ARGS+=( "--tor.active" "--tor.socks=${TOR_PROXY_IP}:${TOR_PROXY_PORT}" )
BIN_ARGS+=( "--maxpendingchannels=2" )

export APP_BOOST_LND_COMMAND=$(IFS=" "; echo "${BIN_ARGS[@]}")
