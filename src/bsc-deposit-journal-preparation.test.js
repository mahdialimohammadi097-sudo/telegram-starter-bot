import test from "node:test";
import assert from "node:assert/strict";
import {prepareBscDepositJournal as prepare} from "./bsc-deposit-journal-preparation.js";
const tx="0x"+"a".repeat(64),blockHash="0x"+"b".repeat(64);
const token="0x"+"c".repeat(40),address="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log={logIndex:"0x2",address:token,transactionHash:tx,blockHash,blockNumber:"0x64",
 topics:[topic,"0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+address.slice(2)],
 data:"0x"+(125n*10n**16n).toString(16).padStart(64,"0")};
const receipt={transactionHash:tx,blockHash,blockNumber:"0x64",status:"0x1",logs:[log]};
const rpc=async method=>({
 eth_chainId:"0x38",eth_getTransactionReceipt:receipt,
 eth_getTransactionByHash:{hash:tx,blockHash,blockNumber:"0x64"},
 eth_getBlockByNumber:{hash:blockHash,number:"0x64"},eth_blockNumber:"0x78"
})[method];
const row={wallet_id:"3",user_id:"12",chain_id:"56",wallet_address:address,start_block:"50",end_block:null,
 wallet_id_current:"3",wallet_chain_id:"56",wallet_address_current:address,is_platform_controlled:true};
const expected={transactionHash:tx,tokenContract:token,depositAddress:address,logIndex:2,tokenDecimals:18,minConfirmations:12};
const accountRows=[{id:"4",user_id:"12",account_type:"AVAILABLE",currency:"USDT"},
 {id:"5",user_id:null,account_type:"CLEARING",currency:"USDT"}];
const base={rpc,transactionHash:tx,expected,expectedUserId:"12",
 userAvailableAccountId:"4",platformClearingAccountId:"5"};
const clientWith=(owner=row,accounts=accountRows)=>({query:async sql=>
 sql.includes("deposit_address_ownership_history")?{rows:[owner],rowCount:1}:{rows:accounts,rowCount:accounts.length}});
ableAccountId:"4",platformClearingAccountId:"5"};
const clientWith=(owner=row,accounts=accountRows)=>({query:async sql=>
 sql.includes("deposit_address_ownership_history")?{rows:[owner],rowCount:1}:{rows:accounts,rowCount:accounts.length}});
