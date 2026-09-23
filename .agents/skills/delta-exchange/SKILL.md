---
name: delta-exchange
description: >-
  Guide and tool reference for Delta Exchange India & Global via Model Context Protocol (MCP)
  and direct API integration. Use when interacting with Delta Exchange market data,
  orderbooks, option chains, open interest, and executing trades.
---

# Delta Exchange MCP Integration Guide

This skill provides comprehensive instructions for interacting with **Delta Exchange** via the Model Context Protocol (MCP) server (`delta-exchange-mcp`) and direct REST/WebSocket APIs.

---

## 1. Architecture Overview

- **MCP Server**: `delta-exchange-mcp` connects AI agents directly to Delta Exchange via standard stdio JSON-RPC.
- **Supported Environments**:
  - `india_prod`: Production Delta Exchange India (`https://api.india.delta.exchange`)
  - `india_testnet`: Testnet environment (`https://demo.delta.exchange`)
  - `global`: Global Delta Exchange (`https://api.delta.exchange`)
- **Tiers of Capability**:
  1. **Market Data (No API keys needed)**: Live tickers, depth/orderbook, candlestick history, funding rates, open interest, options chain.
  2. **Account Read-Only (`DELTA_API_KEY` & `DELTA_API_SECRET`)**: Wallet balances, active positions, open orders, trade history.
  3. **Trading Mode (`DELTA_MCP_MODE=trade`)**: Order placement, stop-loss / take-profit brackets, position closing, leverage setting.

---

## 2. Available MCP Tools Reference

When `delta-exchange-mcp` is running, the following tools become accessible:

| Tool Name | Parameters | Purpose |
|---|---|---|
| `get_ticker` | `symbol: string` | Fetch mark price, spot index, 24h change, high/low, open interest, funding rate |
| `get_candles` | `symbol: string, resolution: string, start: int, end: int` | Get OHLCV candlestick series (`1m`, `5m`, `15m`, `1h`, `1d`) |
| `get_orderbook` | `symbol: string, depth?: int` | Fetch current bid/ask L2 orderbook |
| `get_options_chain` | `underlying_asset: string, expiry_date?: string` | Retrieve options chain with strike prices, Greeks, and IV |
| `get_open_interest` | `symbol: string` | Historical and real-time open interest dynamics |
| `get_balances` | *(none)* | Fetch wallet balances, available margin, and maintenance margin |
| `get_positions` | *(none)* | Retrieve open futures/options positions and unrealized PnL |
| `get_orders` | `state?: string` | List open or historical orders |
| `place_order` | `symbol, size, side, order_type, limit_price?, stop_price?` | Place limit, market, or stop order (Trade mode only) |
| `cancel_order` | `order_id: string` | Cancel active order |

---

## 3. Configuration & Credentials

Credentials should be placed in `~/.delta-exchange-mcp/config.env` or passed via environment variables:

```dotenv
DELTA_API_KEY=your_api_key_here
DELTA_API_SECRET=your_api_secret_here
DELTA_MCP_ENV=india_prod
DELTA_MCP_MODE=read
```

For the Quantitative Backend engine, settings are managed in `backend/config.yaml`.
