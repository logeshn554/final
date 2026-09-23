"""
Model Context Protocol (MCP) Client Bridge for Delta Exchange.
Enables programmatic interaction between the Python Quant Backend and Delta Exchange MCP Server
using JSON-RPC 2.0 stdio protocol.
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import shutil
import sys
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class DeltaMCPBridge:
    """Async client that communicates with delta-exchange-mcp server via stdio JSON-RPC."""

    def __init__(
        self,
        env: str = "india_prod",
        mode: str = "read",
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
    ):
        self.env = env
        self.mode = mode
        self.api_key = api_key
        self.api_secret = api_secret

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._req_id = 0
        self._pending_requests: Dict[int, asyncio.Future] = {}
        self._listen_task: Optional[asyncio.Task] = None
        self._is_initialized = False
        self._available_tools: List[Dict[str, Any]] = []

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def is_available(self) -> bool:
        """Check if uvx or python environment can run the MCP server."""
        return bool(shutil.which("uvx") or shutil.which("python") or shutil.which("python3"))

    async def start(self) -> bool:
        """Launch delta-exchange-mcp subprocess and perform MCP handshake."""
        if self._proc and self._proc.returncode is None:
            return True

        # Construct environment variables for MCP subprocess
        sub_env = os.environ.copy()
        sub_env["DELTA_MCP_ENV"] = self.env
        sub_env["DELTA_MCP_MODE"] = self.mode
        if self.api_key:
            sub_env["DELTA_API_KEY"] = self.api_key
        if self.api_secret:
            sub_env["DELTA_API_SECRET"] = self.api_secret

        cmd = None
        args = []

        if shutil.which("uvx"):
            cmd = "uvx"
            args = ["delta-exchange-mcp"]
        elif shutil.which("python"):
            cmd = "python"
            args = ["-m", "delta_exchange_mcp"]
        else:
            logger.warning("Neither uvx nor python found on PATH to spawn MCP server")
            return False

        try:
            logger.info(f"Starting Delta Exchange MCP server: {cmd} {' '.join(args)}")
            self._proc = await asyncio.create_subprocess_exec(
                cmd,
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=sub_env,
            )

            # Start background reader task
            self._listen_task = asyncio.create_task(self._reader_loop())

            # Perform MCP initialization handshake
            init_payload = {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "roots": {"listChanged": True},
                    "sampling": {},
                },
                "clientInfo": {
                    "name": "quant-engine-delta-client",
                    "version": "1.0.0",
                },
            }

            resp = await self._send_request("initialize", init_payload)
            if resp:
                # Send initialized notification
                await self._send_notification("notifications/initialized", {})
                self._is_initialized = True
                logger.info("Delta Exchange MCP server successfully initialized")

                # Fetch available tools list
                tools_resp = await self._send_request("tools/list", {})
                if tools_resp and "tools" in tools_resp:
                    self._available_tools = tools_resp["tools"]
                    logger.info(f"Discovered {len(self._available_tools)} MCP tools: {[t['name'] for t in self._available_tools]}")

                return True
            return False

        except Exception as e:
            logger.warning(f"Could not connect to Delta Exchange MCP server: {e}")
            return False

    async def _reader_loop(self) -> None:
        """Continuously read line-delimited JSON-RPC responses from stdout."""
        if not self._proc or not self._proc.stdout:
            return

        while self._proc.returncode is None:
            try:
                line = await self._proc.stdout.readline()
                if not line:
                    break

                text = line.decode("utf-8").strip()
                if not text:
                    continue

                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    continue

                # Match with pending request
                msg_id = data.get("id")
                if msg_id is not None and msg_id in self._pending_requests:
                    fut = self._pending_requests.pop(msg_id)
                    if not fut.done():
                        if "error" in data:
                            fut.set_exception(RuntimeError(data["error"]))
                        else:
                            fut.set_result(data.get("result"))

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in MCP reader loop: {e}")
                break

    async def _send_request(self, method: str, params: Dict[str, Any], timeout: float = 10.0) -> Any:
        """Send JSON-RPC request and wait for response."""
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("MCP process is not running")

        req_id = self._next_id()
        msg = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        }

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending_requests[req_id] = fut

        raw = json.dumps(msg) + "\n"
        self._proc.stdin.write(raw.encode("utf-8"))
        await self._proc.stdin.drain()

        return await asyncio.wait_for(fut, timeout=timeout)

    async def _send_notification(self, method: str, params: Dict[str, Any]) -> None:
        """Send JSON-RPC notification (no response expected)."""
        if not self._proc or not self._proc.stdin:
            return

        msg = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        raw = json.dumps(msg) + "\n"
        self._proc.stdin.write(raw.encode("utf-8"))
        await self._proc.stdin.drain()

    async def list_tools(self) -> List[Dict[str, Any]]:
        """List tools exposed by Delta Exchange MCP server."""
        if not self._is_initialized:
            started = await self.start()
            if not started:
                return []
        return self._available_tools

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Execute a tool on Delta Exchange MCP server."""
        if not self._is_initialized:
            started = await self.start()
            if not started:
                raise RuntimeError("MCP server could not be started")

        res = await self._send_request("tools/call", {"name": name, "arguments": arguments})
        return res

    async def get_ticker(self, symbol: str = "ETHUSD") -> Optional[Dict[str, Any]]:
        """Call MCP get_ticker tool."""
        try:
            res = await self.call_tool("get_ticker", {"symbol": symbol})
            return res
        except Exception as e:
            logger.warning(f"MCP get_ticker failed: {e}")
            return None

    async def get_positions(self) -> List[Dict[str, Any]]:
        """Call MCP get_positions tool."""
        try:
            res = await self.call_tool("get_positions", {})
            return res.get("positions", []) if isinstance(res, dict) else []
        except Exception as e:
            logger.warning(f"MCP get_positions failed: {e}")
            return []

    async def place_order(
        self,
        symbol: str = "ETHUSD",
        size: float = 1,
        side: str = "buy",
        order_type: str = "market_order",
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        tp: Optional[float] = None,
        sp: Optional[float] = None,
        take_profit_price: Optional[float] = None,
        stop_loss_price: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """Call MCP place_order tool with Take Profit (TP) and Stop Price (SP/SL) bracket support."""
        try:
            effective_tp = take_profit_price if take_profit_price is not None else tp
            effective_sp = stop_loss_price if stop_loss_price is not None else (sp if sp is not None else stop_price)

            args: Dict[str, Any] = {
                "symbol": symbol,
                "size": size,
                "side": side.lower(),
                "order_type": order_type,
            }
            if limit_price is not None:
                args["limit_price"] = str(round(float(limit_price), 2))
            if effective_sp is not None:
                sp_str = str(round(float(effective_sp), 2))
                args["stop_price"] = sp_str
                args["bracket_stop_loss_price"] = sp_str
                args["bracket_stop_loss_limit_price"] = sp_str
            if effective_tp is not None:
                tp_str = str(round(float(effective_tp), 2))
                args["bracket_take_profit_price"] = tp_str
                args["bracket_take_profit_limit_price"] = tp_str

            res = await self.call_tool("place_order", args)
            return res if isinstance(res, dict) else {"result": res}
        except Exception as e:
            logger.warning(f"MCP place_order failed: {e}")
            return {"success": False, "error": str(e)}

    async def stop(self) -> None:
        """Shut down the MCP subprocess."""
        if self._listen_task:
            self._listen_task.cancel()
        if self._proc:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except Exception:
                if self._proc:
                    self._proc.kill()
        self._is_initialized = False
