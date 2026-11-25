import test from "node:test";
import assert from "node:assert/strict";
import {verifyHistoricalWalletRecord as check} from "./deposit-historical-wallet-record.js";
const address="0x"+"a".repeat(40);
const valid=()=>({history:{wallet_id:"1",user_id:"12",chain_id:56,wallet_address:address,start_block:"100",end_block:"200"},wallet:{id:"1",chain_id:56,wallet_address:address,is_platform_controlled:true},eventBlockNumber:"150",expectedUserId:"12",expectedWalletAddress:address});
test("historical wallet identity and interval must match",()=>{
 assert.deepEqual(check(valid()),{walletId:"1",userId:"12"});
 const pg=valid();pg.history.chain_id="56";pg.wallet.chain_id="56";
 assert.deepEqual(check(pg),{walletId:"1",userId:"12"});
 for(const mutation of [
  p=>p.history.wallet_id="2",p=>p.history.user_id="13",
  p=>p.wallet.wallet_address="0x"+"b".repeat(40),
  p=>p.wallet.is_platform_controlled=false,p=>p.wallet.chain_id=97,
  p=>p.eventBlockNumber="200",p=>p.eventBlockNumber="99",
  p=>p.history.end_block="100",p=>p.history.start_block="bad",
  p=>p.expectedUserId="13"
 ]){const p=valid();mutation(p);assert.throws(()=>check(p));}
});

test("historical ownership rejects malformed identifiers and interval ambiguity",()=>{
 const cases=[
  p=>p.history.wallet_id="0",
  p=>p.history.wallet_id="9223372036854775808",
  p=>p.wallet.id="1.0",
  p=>p.expectedUserId="01",
  p=>p.history.user_id="12 OR 1=1",
  p=>p.history.start_block="-1",
  p=>p.history.start_block="1".repeat(79),
  p=>p.history.end_block="1".repeat(79),
  p=>p.eventBlockNumber="1".repeat(79),
  p=>p.history.start_block="0100",
  p=>p.history.end_block="100",
  p=>p.history.end_block="150",
  p=>p.eventBlockNumber="150.0",
  p=>p.eventBlockNumber="-150",
  p=>p.history.wallet_address="0x"+"A".repeat(40),
  p=>p.wallet.is_platform_controlled=null,
  p=>p.history.chain_id="97"
 ];
 for(const mutation of cases){
  const p=valid();mutation(p);
  assert.throws(()=>check(p));
 }
 const openEnded=valid();openEnded.history.end_block=null;
 assert.throws(()=>check(openEnded),/interval mismatch/);
});

test("matching returned wallet rows must match the requested event address",()=>{
 const p=valid();p.history.wallet_address=p.wallet.wallet_address="0x"+"b".repeat(40);
 assert.throws(()=>check(p),/identity mismatch/);
 p.expectedWalletAddress=p.history.wallet_address=p.wallet.wallet_address="0x"+"0".repeat(40);
 assert.throws(()=>check(p),/identity mismatch/);
 const oversized=valid();oversized.history.user_id="1".repeat(500);assert.throws(()=>check(oversized));
});

test("historical block intervals enforce uint256 independently of numeric precision",()=>{
 const max=(1n<<256n)-1n;
 const beyond=(max+1n).toString();
 const boundary=valid();
 boundary.history.start_block=(max-1n).toString();
 boundary.history.end_block=null;
 boundary.eventBlockNumber=max.toString();
 assert.throws(()=>check(boundary),/interval mismatch/);
 for(const mutate of [
  p=>{p.history.end_block=beyond;},
  p=>{p.history.end_block=null;p.eventBlockNumber=beyond;},
  p=>{p.history.start_block=beyond;p.history.end_block=null;p.eventBlockNumber=beyond;}
 ]){
  const p=valid();mutate(p);assert.throws(()=>check(p),/interval mismatch/);
 }
 const finite=valid();
 finite.history.end_block=max.toString();
 finite.eventBlockNumber=(max-1n).toString();
 assert.deepEqual(check(finite),{walletId:"1",userId:"12"});
 finite.eventBlockNumber=max.toString();
 assert.throws(()=>check(finite),/interval mismatch/);
});
