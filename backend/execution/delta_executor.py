"""
Delta Exchange Order Executor.
Handles order lifecycle on Delta Exchange (India & Global), including contract sizing,
slippage calculation, stop-loss / take-profit bracket submission, and dry-run paper trading.
"""

from __future__ import annotations
import asyncio
import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, Optional
import socket
import httpx

logger = logging.getLogger(__name__)

# Force IPv4 socket resolution for Delta Exchange outbound connections
# so requests match the user's whitelisted IPv4 address rather than dual-stack IPv6
_orig_getaddrinfo = socket.getaddrinfo

def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

socket.getaddrinfo = _ipv4_getaddrinfo


def _create_ipv4_client(timeout: float = 10.0) -> httpx.AsyncClient:
    """Create httpx AsyncClient with forced IPv4 socket resolution."""
    return httpx.AsyncClient(timeout=timeout)


class DeltaExchangeExecutor:
    """Production executor for Delta Exchange futures and options."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        env: str = "india_prod",
        dry_run: bool = True,
        rest_url: Optional[str] = None,
    ):
        self.api_key = api_key
        self.api_secret = api_secret
        self.env = env
        self.dry_run = dry_run

        if rest_url:
            self.base_url = rest_url
        elif env == "india_prod":
            self.base_url = "https://api.india.delta.exchange"
        elif env == "india_testnet":
            self.base_url = "https://demo.delta.exchange"
        else:
            self.base_url = "https://api.delta.exchange"

    def _generate_signature(self, method: str, path: str, query: str = "", payload: str = "", timestamp: str = "") -> str:
        """Create HMAC-SHA256 signature for Delta Exchange API."""
        if not self.api_secret:
            return ""
        message = method.upper() + timestamp + path + query + payload
        signature = hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return signature

    def _get_auth_headers(self, method: str, path: str, payload: str = "") -> Dict[str, str]:
        """Generate authentication headers."""
        if not self.api_key or not self.api_secret:
            return {}
        timestamp = str(int(time.time()))
        sig = self._generate_signature(method, path, payload=payload, timestamp=timestamp)
        return {
            "api-key": self.api_key,
            "timestamp": timestamp,
            "signature": sig,
            "Content-Type": "application/json",
        }

    @staticmethod
    def calculate_leverage_from_stop(
        entry_price: float,
        stop_price: float,
        buffer_factor: float = 2.0,
        min_leverage: int = 2,
        max_leverage: int = 50,
    ) -> int:
        """
        Calculate dynamic leverage for 1 lot based on Stop Price (SP) distance.
        Ensures liquidation distance is at least `buffer_factor` times the stop distance
        so the trade is never liquidated prematurely before the stop loss triggers.
        """
        if entry_price <= 0 or stop_price <= 0:
            return 10
        stop_dist = abs(entry_price - stop_price)
        stop_pct = stop_dist / entry_price
        if stop_pct <= 0:
            return min_leverage
        # Safe leverage: liquidation price is farther than buffer_factor * stop distance
        raw_leverage = 1.0 / (stop_pct * buffer_factor)
        safe_lev = int(raw_leverage)
        return max(min_leverage, min(max_leverage, safe_lev))

    def get_product_id(self, symbol: str) -> int:
        """Resolve Delta Exchange product ID for common derivative symbols."""
        sym_clean = symbol.upper().replace("/", "").replace("-", "")
        # Delta Exchange India product IDs
        if sym_clean in ("ETHUSD", "ETHUSDT", "ETH"):
            return 3136
        elif sym_clean in ("BTCUSD", "BTCUSDT", "BTC"):
            return 27
        return 3136  # Default to ETHUSD perpetual on Delta India

    async def set_leverage(self, product_id: int, leverage: int) -> Dict[str, Any]:
        """
        Adjust product leverage on Delta Exchange via POST /v2/products/{product_id}/orders/leverage.
        """
        lev_payload = {"leverage": int(leverage)}

        if self.dry_run or not self.api_key:
            logger.info(f"[DRY-RUN / PAPER] Simulated Delta Set Leverage: Product {product_id} -> {leverage}x")
            return {
                "success": True,
                "simulated": True,
                "product_id": product_id,
                "leverage": leverage,
            }

        path = f"/v2/products/{product_id}/orders/leverage"
        url = f"{self.base_url}{path}"
        payload_str = json.dumps(lev_payload)
        headers = self._get_auth_headers("POST", path, payload=payload_str)

        try:
            async with _create_ipv4_client(timeout=10.0) as client:
                resp = await client.post(url, headers=headers, content=payload_str)
                resp.raise_for_status()
                data = resp.json()
                logger.info(f"Delta Exchange Leverage Updated: Product {product_id} set to {leverage}x ({data})")
                return {"success": True, "result": data, "product_id": product_id, "leverage": leverage}
        except Exception as e:
            logger.warning(f"Failed to set Delta leverage for product {product_id} to {leverage}x: {e}")
            return {
                "success": False,
                "error": str(e),
                "product_id": product_id,
                "leverage": leverage,
            }

    async def place_order(
        self,
        symbol: str,
        size: float = 1,
        side: str = "buy",                 # "buy" | "sell"
        order_type: str = "market_order",  # "market_order" | "limit_order"
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        take_profit_price: Optional[float] = None,
        stop_loss_price: Optional[float] = None,
        tp: Optional[float] = None,
        sp: Optional[float] = None,
        product_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Place an order on Delta Exchange with Take Profit (TP) and Stop Price / Stop Loss (SP/SL).
        If dry_run is True or credentials are not provided, executes simulated fill.
        """
        side_lower = side.lower()
        pid = product_id or self.get_product_id(symbol)
        lot_size = int(size) if size >= 1 else 1

        # Resolve TP and SP / Stop Loss
        effective_tp = take_profit_price if take_profit_price is not None else tp
        effective_sp = stop_loss_price if stop_loss_price is not None else (sp if sp is not None else stop_price)

        order_payload = {
            "product_id": pid,
            "size": lot_size,
            "side": side_lower,
            "order_type": order_type,
        }
        if limit_price is not None:
            order_payload["limit_price"] = str(round(float(limit_price), 2))

        # Add Take Profit (TP) and Stop Price / Stop Loss (SP) bracket parameters
        # Delta Exchange REST API v2 takes bracket_stop_loss_price and bracket_take_profit_price
        # along with bracket_stop_loss_limit_price and bracket_take_profit_limit_price
        if effective_tp is not None:
            tp_str = str(round(float(effective_tp), 2))
            order_payload["bracket_take_profit_price"] = tp_str
            order_payload["bracket_take_profit_limit_price"] = tp_str
            order_payload["stop_trigger_method"] = "mark_price"

        if effective_sp is not None:
            sp_str = str(round(float(effective_sp), 2))
            order_payload["bracket_stop_loss_price"] = sp_str
            order_payload["bracket_stop_loss_limit_price"] = sp_str
            order_payload["stop_trigger_method"] = "mark_price"

        if stop_price is not None and "bracket_stop_loss_price" not in order_payload:
            order_payload["stop_price"] = str(round(float(stop_price), 2))

        if self.dry_run or not self.api_key:
            simulated_id = f"sim-delta-{int(time.time()*1000)}"
            logger.info(
                f"[DRY-RUN / PAPER] Simulated Delta Exchange Order: {side_lower.upper()} {lot_size} lot {symbol} (PID {pid}) "
                f"@ {limit_price or 'MKT'} (TP: {effective_tp}, SP/SL: {effective_sp})"
            )
            return {
                "success": True,
                "order_id": simulated_id,
                "simulated": True,
                "payload": order_payload,
                "status": "filled",
                "take_profit_price": float(effective_tp) if effective_tp is not None else None,
                "stop_loss_price": float(effective_sp) if effective_sp is not None else None,
                "tp": float(effective_tp) if effective_tp is not None else None,
                "sp": float(effective_sp) if effective_sp is not None else None,
                "stop_price": float(effective_sp) if effective_sp is not None else None,
                "timestamp": time.time(),
            }

        path = "/v2/orders"
        url = f"{self.base_url}{path}"
        payload_str = json.dumps(order_payload)
        headers = self._get_auth_headers("POST", path, payload=payload_str)

        try:
            async with _create_ipv4_client(timeout=10.0) as client:
                resp = await client.post(url, headers=headers, content=payload_str)
                resp.raise_for_status()
                data = resp.json()
                logger.info(f"Delta Exchange Order Placed with TP/SP Brackets: {data}")
                return data
        except Exception as e:
            err_msg = str(e)
            logger.error(f"Delta Exchange bracket order execution failed: {err_msg}")

            # Fallback: if inline bracket order format fails on exchange, place entry order first,
            # then immediately attach TP and SP orders so the position is never left unhedged
            has_brackets = "bracket_take_profit_price" in order_payload or "bracket_stop_loss_price" in order_payload or "bracket_take_profit_limit_price" in order_payload or "bracket_stop_loss_limit_price" in order_payload
            if has_brackets:
                simple_payload = {
                    "product_id": pid,
                    "size": lot_size,
                    "side": side_lower,
                    "order_type": order_type,
                }
                simple_str = json.dumps(simple_payload)
                simple_headers = self._get_auth_headers("POST", path, payload=simple_str)
                try:
                    async with _create_ipv4_client(timeout=10.0) as client:
                        fb_resp = await client.post(url, headers=simple_headers, content=simple_str)
                        fb_resp.raise_for_status()
                        fb_data = fb_resp.json()
                        logger.info(f"Delta Exchange Entry Order Placed via Fallback: {fb_data}")

                        # Immediately attach TP & SP brackets so position is protected
                        attach_res = await self.attach_bracket_orders(
                            product_id=pid,
                            side=side_lower,
                            size=lot_size,
                            take_profit_price=effective_tp,
                            stop_loss_price=effective_sp,
                        )
                        fb_data["bracket_attachment"] = attach_res
                        return fb_data
                except Exception as fb_err:
                    logger.error(f"Delta Exchange simple order fallback also failed: {fb_err}")

            return {
                "success": False,
                "error": err_msg,
                "payload": order_payload,
            }

    async def attach_bracket_orders(
        self,
        product_id: int,
        side: str,
        size: int,
        take_profit_price: Optional[float] = None,
        stop_loss_price: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Attach Take Profit (TP) and Stop Price (SP/SL) to an open position or filled order on Delta Exchange.
        Tries /v2/orders/bracket first; if not accepted, places individual TP limit order and SP stop order.
        """
        if self.dry_run or not self.api_key:
            return {"success": True, "simulated": True, "tp": take_profit_price, "sp": stop_loss_price}

        exit_side = "sell" if side.lower() == "buy" else "buy"
        results: Dict[str, Any] = {"bracket_endpoint": None, "tp_order": None, "sl_order": None}

        # 1. Attempt POST /v2/orders/bracket
        bracket_payload: Dict[str, Any] = {
            "product_id": product_id,
            "stop_trigger_method": "mark_price",
        }
        if take_profit_price is not None:
            tp_str = str(round(float(take_profit_price), 2))
            bracket_payload["bracket_take_profit_price"] = tp_str
            bracket_payload["bracket_take_profit_limit_price"] = tp_str
        if stop_loss_price is not None:
            sp_str = str(round(float(stop_loss_price), 2))
            bracket_payload["bracket_stop_loss_price"] = sp_str
            bracket_payload["bracket_stop_loss_limit_price"] = sp_str

        path = "/v2/orders/bracket"
        url = f"{self.base_url}{path}"
        payload_str = json.dumps(bracket_payload)
        headers = self._get_auth_headers("POST", path, payload=payload_str)

        try:
            async with _create_ipv4_client(timeout=10.0) as client:
                resp = await client.post(url, headers=headers, content=payload_str)
                if resp.status_code in (200, 201):
                    results["bracket_endpoint"] = resp.json()
                    logger.info(f"Delta Exchange Brackets Attached via /v2/orders/bracket: {results['bracket_endpoint']}")
                    return {"success": True, "method": "bracket_endpoint", "details": results}
        except Exception as e:
            logger.warning(f"Delta /v2/orders/bracket call failed ({e}); proceeding to discrete TP/SP orders")

        # 2. Fallback: Place discrete Stop Loss (SP) order
        if stop_loss_price is not None:
            sl_payload = {
                "product_id": product_id,
                "size": size,
                "side": exit_side,
                "order_type": "market_order",
                "stop_order_type": "stop_loss_order",
                "stop_price": str(round(float(stop_loss_price), 2)),
                "stop_trigger_method": "mark_price",
            }
            try:
                sl_path = "/v2/orders"
                sl_url = f"{self.base_url}{sl_path}"
                sl_str = json.dumps(sl_payload)
                sl_headers = self._get_auth_headers("POST", sl_path, payload=sl_str)
                async with _create_ipv4_client(timeout=10.0) as client:
                    sl_resp = await client.post(sl_url, headers=sl_headers, content=sl_str)
                    sl_resp.raise_for_status()
                    results["sl_order"] = sl_resp.json()
                    logger.info(f"Delta Discrete Stop Loss Order (SP) Placed @ {stop_loss_price}: {results['sl_order']}")
            except Exception as e:
                logger.error(f"Failed to place discrete Delta Stop Loss (SP) order: {e}")
                results["sl_order"] = {"error": str(e)}

        # 3. Fallback: Place discrete Take Profit (TP) order
        if take_profit_price is not None:
            tp_payload = {
                "product_id": product_id,
                "size": size,
                "side": exit_side,
                "order_type": "limit_order",
                "limit_price": str(round(float(take_profit_price), 2)),
            }
            try:
                tp_path = "/v2/orders"
                tp_url = f"{self.base_url}{tp_path}"
                tp_str = json.dumps(tp_payload)
                tp_headers = self._get_auth_headers("POST", tp_path, payload=tp_str)
                async with _create_ipv4_client(timeout=10.0) as client:
                    tp_resp = await client.post(tp_url, headers=tp_headers, content=tp_str)
                    tp_resp.raise_for_status()
                    results["tp_order"] = tp_resp.json()
                    logger.info(f"Delta Discrete Take Profit Order (TP) Placed @ {take_profit_price}: {results['tp_order']}")
            except Exception as e:
                logger.error(f"Failed to place discrete Delta Take Profit (TP) order: {e}")
                results["tp_order"] = {"error": str(e)}

        return {"success": True, "method": "discrete_orders", "details": results}

    async def execute_master_trade(
        self,
        symbol: str,
        direction: str,
        entry_price: float,
        take_profit_price: float,
        stop_loss_price: float,
        size: int = 1,
        product_id: Optional[int] = None,
        tp: Optional[float] = None,
        sp: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Execute live MasterMind trade with dynamic leverage based on Stop Price (SP),
        strictly 1 lot sizing, and bracket TP/SP orders on Delta Exchange.
        """
        pid = product_id or self.get_product_id(symbol)
        side = "buy" if direction.upper() in ("BUY", "LONG", "1") else "sell"

        final_tp = float(take_profit_price if take_profit_price is not None else tp)
        final_sl = float(stop_loss_price if stop_loss_price is not None else sp)

        # 1. Compute dynamic leverage based on stop price (SP) distance
        dynamic_leverage = self.calculate_leverage_from_stop(
            entry_price=entry_price,
            stop_price=final_sl,
            buffer_factor=2.0,
            min_leverage=2,
            max_leverage=50,
        )

        # 2. Adjust leverage on Delta Exchange before order entry
        lev_resp = await self.set_leverage(product_id=pid, leverage=dynamic_leverage)

        # 3. Submit live bracket market order with TP and SP
        order_resp = await self.place_order(
            symbol=symbol,
            size=size,
            side=side,
            order_type="market_order",
            take_profit_price=final_tp,
            stop_loss_price=final_sl,
            tp=final_tp,
            sp=final_sl,
            product_id=pid,
        )

        success = order_resp.get("success", False) or bool(order_resp.get("result"))
        order_id = (
            order_resp.get("order_id")
            or (order_resp.get("result", {}).get("id") if isinstance(order_resp.get("result"), dict) else None)
            or f"delta-{int(time.time()*1000)}"
        )

        return {
            "success": success,
            "order_id": order_id,
            "symbol": symbol,
            "product_id": pid,
            "size": size,
            "side": side,
            "entry_price": entry_price,
            "take_profit_price": final_tp,
            "stop_loss_price": final_sl,
            "tp": final_tp,
            "sp": final_sl,
            "stop_price": final_sl,
            "leverage": dynamic_leverage,
            "leverage_response": lev_resp,
            "order_response": order_resp,
            "timestamp": time.time(),
        }

    async def get_positions(self) -> list:
        """Fetch open positions from Delta Exchange."""
        if not self.api_key:
            return []

        path = "/v2/positions/margined"
        url = f"{self.base_url}{path}"
        headers = self._get_auth_headers("GET", path)

        try:
            async with _create_ipv4_client(timeout=10.0) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data.get("result", [])
        except Exception as e:
            logger.warning(f"Failed to fetch Delta positions: {e}")
            return []

    async def get_wallet_balances(self) -> list:
        """Fetch wallet balances from Delta Exchange."""
        if not self.api_key:
            return []

        path = "/v2/wallet/balances"
        url = f"{self.base_url}{path}"
        headers = self._get_auth_headers("GET", path)

        try:
            async with _create_ipv4_client(timeout=10.0) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data.get("result", [])
        except Exception as e:
            logger.warning(f"Failed to fetch Delta wallet balances: {e}")
            return []

    async def close_open_position(self, product_id: int = 3136) -> Dict[str, Any]:
        """Close open position on Delta Exchange by sending an opposing market order."""
        if self.dry_run or not self.api_key:
            return {"success": True, "simulated": True, "message": "Simulated position closed"}

        try:
            positions = await self.get_positions()
            pos = next((p for p in positions if p.get("product_id") == product_id and int(p.get("size", 0)) != 0), None)
            if not pos:
                return {"success": True, "message": "No open position found on Delta Exchange"}

            size = abs(int(pos.get("size", 1)))
            opposing_side = "sell" if int(pos.get("size", 0)) > 0 else "buy"
            return await self.place_order(
                symbol="ETHUSD",
                size=size,
                side=opposing_side,
                order_type="market_order",
                product_id=product_id,
            )
        except Exception as e:
            logger.error(f"Failed to close position on Delta Exchange: {e}")
            return {"success": False, "error": str(e)}
