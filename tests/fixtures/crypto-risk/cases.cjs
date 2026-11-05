// Synthetic wallets for the risk rules. Every address is generated and nothing refers
// to a real wallet. Built in code rather than stored as JSON, because a fixture's
// point is its shape: "six receipts, each forwarded in 12 minutes" reads here and
// would not read as 12 rows of generated data.
//
// labels:  acceptable labels for this wallet.
// codes:   findings that must be present.
// scoring: true when a benign shape is allowed to carry a scoring finding.
// absent:  findings that must not appear.
// score:   exact score, where the number itself is the point of the fixture.
const T0=Date.parse("2026-10-01T00:00:00Z");
const MIN=60e3,HOUR=3600e3,DAY=86400e3;
const USDT="0xdac17f958d2ee523a2206206994597c13d831ec7";

let serial=0;
const a=index=>"0x"+String(index).padStart(40,"0");
const native=(ms,direction,amount,counterparty,extra={})=>({
  id:"tx"+(++serial),time:new Date(T0+ms).toISOString(),direction,asset:"ETH",asset_key:"native",amount,
  counterparties:counterparty?[counterparty]:[],...extra
});
const usdt=(ms,direction,amount,counterparty,extra={})=>native(ms,direction,amount,counterparty,{asset:"USDT",asset_key:USDT,token_contract:USDT,stable:true,...extra});
const btc=(ms,direction,amount,counterparty,extra={})=>native(ms,direction,amount,counterparty,{asset:"BTC",...extra});
const SCREENED={status:"ok",hit:false,counterparty_matches:[]};
const wallet=(transactions,extra={})=>({chain:"ethereum",kind:"address",query:a(1),transactions,sanctions_screening:SCREENED,coverage:{complete:false},...extra});
const bitcoin=(transactions,extra={})=>wallet(transactions,{chain:"bitcoin",query:"bc1qsyntheticseed",...extra});
const listed=(address,extra={})=>({
  address,summary:"SYNTHETIC ENTITY [SDGT]",entities:[{name:"SYNTHETIC ENTITY",programs:["SDGT"],terrorism:true}],
  received_from_count:1,sent_to_count:0,spent_with_count:0,tx_ids:["tx"],...extra
});
const hit=(...matches)=>({sanctions_screening:{status:"ok",hit:true,counterparty_matches:matches}});

const cases=[];
const add=(name,labels,codes,analysis,ctx={},options={})=>cases.push({name,labels,codes,analysis,ctx,...options});

// ------------------------------- benign shapes -------------------------------
add("retail: buys and pays over 8 months",["LOW"],[],wallet([
  native(0,"IN",1,a(10)),native(20*DAY,"OUT",0.2,a(11)),native(40*DAY,"OUT",0.1,a(12)),native(70*DAY,"IN",0.5,a(10)),
  native(90*DAY,"OUT",0.3,a(13)),native(130*DAY,"OUT",0.05,a(14)),native(170*DAY,"IN",0.4,a(10)),native(210*DAY,"OUT",0.25,a(15))
]));

{
  const rows=[];
  for(let month=0;month<3;month++){
    rows.push(usdt(month*30*DAY,"IN",60000,a(20)));
    for(let i=0;i<12;i++)rows.push(usdt(month*30*DAY+3*DAY+i*MIN,"OUT",3000+i*250,a(100+i)));
  }
  add("payroll: monthly funding, same 12 staff, varied pay",["LOW","ELEVATED"],[],wallet(rows),{},{scoring:true});
}

{
  const rows=[usdt(0,"IN",60000,a(20))];
  for(let i=0;i<12;i++)rows.push(usdt(2*HOUR+i*MIN,"OUT",3000+i*250,a(100+i)));
  add("first payroll, funded the same day, all staff new to the sample",["LOW","ELEVATED"],[],wallet(rows),{},{scoring:true});
}

{
  const rows=[];
  for(let i=0;i<100;i++)rows.push(native(i*4*MIN,i%2?"OUT":"IN",0.1+(i%7)*0.37,a(200+i)));
  add("exchange hot wallet: the service discount keeps it LOW",["LOW"],[],wallet(rows),{exchangeBehavior:{status:"behavioral_candidate",score:95}},{scoring:true});
}

{
  const rows=[];
  for(let i=0;i<30;i++){
    rows.push(usdt(i*DAY,"OUT",1000+i*13,a(300)));
    rows.push(native(i*DAY+2*MIN,"IN",0.3+i*0.01,a(300)));
  }
  add("DEX trader: swaps change asset, so nothing passes through in one asset",["LOW"],[],wallet(rows));
}

add("cold storage move after 200 quiet days",["LOW"],[],wallet([
  native(0,"IN",50,a(10)),native(2*DAY,"IN",30,a(10)),native(4*DAY,"IN",20,a(10)),native(6*DAY,"IN",5,a(10)),native(8*DAY,"IN",5,a(10)),
  native(208*DAY,"OUT",110,a(11))
]));

{
  const rows=[];
  for(let i=0;i<30;i++)rows.push(native(i*2*HOUR,"IN",0,a(400+i),{asset:"FREE",asset_key:"0xabc"+i,token_contract:"0xabc"+i,spam:true}));
  rows.push(native(0,"IN",1,a(10)),native(5*DAY,"OUT",0.2,a(11)),native(9*DAY,"OUT",0.1,a(12)),native(14*DAY,"OUT",0.1,a(13)),native(19*DAY,"OUT",0.05,a(14)));
  add("airdrop spam on an otherwise quiet wallet",["LOW"],[],wallet(rows));
}

{
  const real="0xabcdef0000000000000000000000000000001234";
  const fake="0xabcdef1111111111111111111111111111111234";
  add("address poisoning target: zero-value look-alike rows",["LOW"],["ADDRESS_POISONING_TARGET"],wallet([
    usdt(0,"OUT",500,real),usdt(DAY,"OUT",700,real),usdt(2*DAY,"IN",900,a(10)),usdt(5*DAY,"OUT",200,a(11)),usdt(8*DAY,"OUT",150,a(12)),
    usdt(DAY+MIN,"OUT",0,fake),usdt(DAY+2*MIN,"OUT",0,fake)
  ]));
}

{
  const rows=[];
  for(let i=0;i<6;i++)rows.push(native(i*10*MIN,"OUT",3,a(40+i),{failed:true}));
  rows.push(native(0,"IN",5,a(10)),native(3*DAY,"OUT",1,a(11)),native(6*DAY,"OUT",1,a(12)),native(9*DAY,"OUT",0.5,a(13)),native(12*DAY,"IN",1,a(10)));
  add("six failed sends are ignored",["LOW"],[],wallet(rows));
}

add("exchange withdrawal forwarded once to own wallet",["LOW"],[],wallet([
  native(0,"IN",3,a(10)),native(9*MIN,"OUT",2.99,a(11)),native(20*DAY,"IN",1,a(12)),native(40*DAY,"OUT",0.5,a(13)),native(60*DAY,"OUT",0.2,a(14))
]));

add("same forwarding habit twice stays at moderate strength",["LOW"],["RAPID_PASS_THROUGH"],wallet([
  native(0,"IN",3,a(10)),native(9*MIN,"OUT",2.99,a(11)),native(20*DAY,"IN",2,a(10)),native(20*DAY+11*MIN,"OUT",1.99,a(11)),native(60*DAY,"OUT",0.002,a(14))
]));

{
  const rows=[];
  for(let i=0;i<45;i++)rows.push(usdt(i*16*HOUR,"IN",12+(i%11)*9,a(1600+i)));
  for(let week=0;week<4;week++)rows.push(usdt((week+1)*7*DAY,"OUT",800,a(31)));
  add("KNOWN FALSE POSITIVE: shop taking small payments, weekly sweep",["ELEVATED"],["DONATION_STYLE_FAN_IN"],wallet(rows));
}

{
  const rows=[];
  for(let i=0;i<5;i++)rows.push(usdt(i*10*MIN,"IN",100,a(2200+i)));
  rows.push(usdt(HOUR,"OUT",100,a(2300)));
  add("five receipts, one send: a send explains one receipt once",["LOW"],[],wallet(rows),{},{absent:["RAPID_PASS_THROUGH"]});
}

{
  const inputs=start=>Array.from({length:5},(_,i)=>"bc1qinput"+(start+i));
  const rows=[0,1,2].map(i=>btc(i*HOUR,"IN",0.5,"",{counterparties:inputs(i*5)}));
  rows.push(btc(5*DAY,"OUT",0.1,"bc1qa"),btc(9*DAY,"OUT",0.2,"bc1qb"),btc(19*DAY,"OUT",0.1,"bc1qc"));
  add("three Bitcoin payers with many inputs are three senders, not fifteen",["LOW"],[],bitcoin(rows),{},{absent:["FAN_IN"]});
}

{
  const rows=[native(0,"IN",60000,a(10),{asset:"TRX"})];
  [9500,9700,9400,9800,9600].forEach((value,i)=>rows.push(native(DAY+i*18*HOUR,"OUT",value,a(30+(i%2)),{asset:"TRX"})));
  rows.push(native(9*DAY,"OUT",120,a(40),{asset:"TRX"}));
  add("native amounts under a band are not read as structuring",["LOW"],[],wallet(rows),{},{absent:["STRUCTURING_BAND"]});
}

{
  const rows=[];
  for(let i=0;i<20;i++)rows.push(btc(i*12*HOUR,"IN",50+i*1.3,"bc1qpayer"+i));
  for(let sweep=0;sweep<3;sweep++)rows.push(btc((sweep+1)*3*DAY,"OUT",100,"bc1qtreasury"));
  add("large Bitcoin receipts are not small donations, whatever the count",["LOW"],[],bitcoin(rows),{},{absent:["DONATION_STYLE_FAN_IN"],scoring:true});
}

{
  const rows=[usdt(0,"IN",3000,a(10)),usdt(6*HOUR,"IN",3000,a(11)),usdt(12*HOUR,"IN",3000,a(12))];
  for(let i=0;i<9;i++)rows.push(usdt(13*HOUR+i*MIN,"OUT",800+i*7,a(2400+i)));
  add("three separate funders are too many for a fan-out",["LOW"],[],wallet(rows),{},{absent:["FAN_OUT"]});
}

{
  const rows=[];
  for(let i=0;i<5;i++){
    rows.push(native(i*2*DAY,"OUT",20+i,a(900)));
    rows.push(native(i*2*DAY+3*HOUR,"IN",4+i,a(900)));
  }
  add("back and forth with unequal amounts is not cycling",["LOW"],[],wallet(rows),{},{absent:["VALUE_CYCLING"],scoring:true});
}

{
  const rows=[usdt(0,"IN",60000,a(10))];
  [9500,9700,9400].forEach((value,i)=>rows.push(usdt(DAY+i*18*HOUR,"OUT",value,a(30))));
  [1210,2430,1750,3120,2260].forEach((value,i)=>rows.push(usdt(DAY+i*12*HOUR+HOUR,"OUT",value,a(2600+i))));
  add("a few amounts under a band among many others is not structuring",["LOW"],[],wallet(rows),{},{absent:["STRUCTURING_BAND"]});
}

{
  const exchanges=[a(31),a(32),a(33)];
  const labels=exchanges.map((address,i)=>({address,category:"EXCHANGE",name:"Exchange "+i}));
  add("unsourced exchange labels never count",["LOW"],[],wallet([
    usdt(0,"IN",9000,exchanges[0]),usdt(2*HOUR,"OUT",3000,exchanges[1]),usdt(DAY,"OUT",3000,exchanges[2]),usdt(2*DAY,"OUT",2900,exchanges[0]),usdt(9*DAY,"OUT",10,a(50))
  ]),{labels},{absent:["EXCHANGE_HOPPING"]});
}

{
  const rows=[];
  for(let i=0;i<4;i++)rows.push(native(i*DAY,"IN",0,a(2500+i),{asset:"FREE",asset_key:"0xfree",token_contract:"0xfree"}));
  rows.push(native(0,"IN",1,a(10)),native(5*DAY,"OUT",0.2,a(11)),native(9*DAY,"OUT",0.1,a(12)),native(14*DAY,"OUT",0.1,a(13)),native(19*DAY,"OUT",0.05,a(14)));
  add("zero-value airdrops received are not address poisoning",["LOW"],[],wallet(rows),{},{absent:["ADDRESS_POISONING_TARGET"]});
}

const quiet=()=>[native(0,"IN",50,a(10)),native(5*DAY,"OUT",5,a(11)),native(9*DAY,"OUT",5,a(12)),native(12*DAY,"OUT",3,a(13))];

add("native dust from a listed address is not HIGH",["LOW"],["SANCTIONED_DUST_RECEIVED"],wallet(
  [...quiet(),native(15*DAY,"IN",0.00001,a(66))],hit(listed(a(66)))
));

add("unknown token from a listed address is not HIGH, whatever its amount",["LOW"],["SANCTIONED_DUST_RECEIVED"],wallet(
  [...quiet(),native(15*DAY,"IN",5000000,a(66),{asset:"JUNK",asset_key:"0xjunk",token_contract:"0xjunk"})],hit(listed(a(66)))
));

add("zero-value row from a listed address is not HIGH",["LOW"],["SANCTIONED_DUST_RECEIVED"],wallet(
  [...quiet(),native(15*DAY,"IN",0,a(66),{asset:"JUNK",asset_key:"0xjunk",token_contract:"0xjunk"})],hit(listed(a(66)))
));

add("dust from several listed addresses still scores once",["LOW"],["SANCTIONED_DUST_RECEIVED"],wallet(
  [...quiet(),...[66,67,68,69,70,71].map(index=>native(15*DAY+index,"IN",0.00001,a(index)))],
  hit(...[66,67,68,69,70,71].map(index=>listed(a(index))))
));

add("three transfers only",["NOT_ASSESSED"],[],wallet([native(0,"IN",1,a(10)),native(DAY,"OUT",1,a(11)),native(2*DAY,"IN",1,a(10))]));

add("quiet wallet but sanctions list unavailable",["NOT_ASSESSED"],[],wallet([
  native(0,"IN",1,a(10)),native(9*DAY,"OUT",0.2,a(11)),native(19*DAY,"OUT",0.1,a(12)),native(29*DAY,"OUT",0.1,a(13)),native(39*DAY,"OUT",0.05,a(14))
],{sanctions_screening:{status:"unavailable",hit:false,counterparty_matches:[]}}));

add("quiet wallet on a stale list is still assessed",["LOW"],[],wallet([
  native(0,"IN",1,a(10)),native(9*DAY,"OUT",0.2,a(11)),native(19*DAY,"OUT",0.1,a(12)),native(29*DAY,"OUT",0.1,a(13)),native(39*DAY,"OUT",0.05,a(14))
],{sanctions_screening:{status:"stale",hit:false,counterparty_matches:[]}}));

add("a provider failed, so a quiet result cannot read as LOW",["NOT_ASSESSED"],[],wallet([
  native(0,"IN",1,a(10)),native(9*DAY,"OUT",0.2,a(11)),native(19*DAY,"OUT",0.1,a(12)),native(29*DAY,"OUT",0.1,a(13)),native(39*DAY,"OUT",0.05,a(14))
],{coverage:{complete:false,partial:true}}));

// ------------------------------- positive shapes -------------------------------
{
  const rows=[];
  for(let i=0;i<6;i++){
    rows.push(usdt(i*6*HOUR,"IN",8000+i*317,a(500+i)));
    rows.push(usdt(i*6*HOUR+12*MIN,"OUT",(8000+i*317)*0.985,a(600+i)));
  }
  add("mule: every receipt forwarded in 12 minutes",["ELEVATED"],["RAPID_PASS_THROUGH"],wallet(rows));
}

{
  const rows=[usdt(0,"IN",60000,a(10))];
  for(let i=0;i<16;i++)rows.push(usdt(30*MIN+i*4*MIN,"OUT",3700+(i%3)*20,a(700+i)));
  add("one receipt split to 16 fresh wallets in an hour",["ELEVATED"],["FAN_OUT","RAPID_PASS_THROUGH"],wallet(rows));
}

{
  const rows=[usdt(0,"IN",60000,a(10))];
  [9500,9700,9400,9800,9600].forEach((value,i)=>rows.push(usdt(DAY+i*18*HOUR,"OUT",value,a(30+(i%2)))));
  rows.push(usdt(9*DAY,"OUT",120,a(40)));
  add("structuring: five sends just under 10,000 in four days",["ELEVATED"],["STRUCTURING_BAND"],wallet(rows));
}

{
  const rows=[native(0,"IN",40,a(10)),native(3*DAY,"IN",30,a(11))];
  for(let i=0;i<7;i++)rows.push(native(200*DAY+i*2*HOUR,"OUT",10,a(800+i)));
  add("dormancy then a burst drains the wallet",["LOW","ELEVATED"],["DORMANT_THEN_BURST"],wallet(rows));
}

{
  const rows=[];
  for(let i=0;i<5;i++){
    rows.push(native(i*2*DAY,"OUT",20,a(900)));
    rows.push(native(i*2*DAY+3*HOUR,"IN",19.5,a(900)));
  }
  add("cycling: same 20 ETH back and forth five times",["ELEVATED"],["VALUE_CYCLING"],wallet(rows));
}

{
  const exchanges=[a(31),a(32),a(33)];
  const labels=exchanges.map((address,i)=>({address,category:"EXCHANGE",name:"Exchange "+i,source_title:"Synthetic source"}));
  add("exchange hopping: out to three exchanges, one relay",["LOW","ELEVATED"],["EXCHANGE_HOPPING"],wallet([
    usdt(0,"IN",9000,exchanges[0]),usdt(2*HOUR,"OUT",3000,exchanges[1]),usdt(DAY,"OUT",3000,exchanges[2]),usdt(2*DAY,"OUT",2900,exchanges[0]),usdt(9*DAY,"OUT",10,a(50))
  ]),{labels});
}

{
  const rows=[];
  for(let i=0;i<40;i++)rows.push(native(i*12*HOUR,"IN",0.002+(i%9)*0.0007,a(1000+i)));
  for(let sweep=0;sweep<3;sweep++)rows.push(native((sweep+1)*6*DAY,"OUT",0.02,a(60)));
  add("donation-style: 40 small payers, swept to one wallet, reaches ELEVATED alone",["ELEVATED"],["DONATION_STYLE_FAN_IN"],wallet(rows));
}

{
  const rows=[];
  for(let i=0;i<12;i++)rows.push(native(i*30*MIN,"IN",1+i*0.1,a(1800+i)));
  rows.push(native(8*HOUR,"OUT",15,a(61)));
  add("fan-in: twelve senders in a day, moved on to one address",["LOW","ELEVATED"],["FAN_IN"],wallet(rows));
}

{
  const rows=[native(-30*DAY,"IN",9,a(10))];
  for(let i=0;i<6;i++)rows.push(native(i*DAY,"OUT",1.5,a(1900+i)));
  rows.push(native(7*DAY,"OUT",0.3333,a(1950)));
  add("same round amount repeated",["LOW"],["ROUND_AMOUNT_CLUSTER"],wallet(rows));
}

{
  const rows=[];
  for(let i=0;i<22;i++)rows.push(native(i*HOUR,i%2?"OUT":"IN",0.1+i*0.017,a(2000+i)));
  add("twenty-two transfers in a day",["LOW"],["HIGH_VELOCITY"],wallet(rows));
}

{
  const rows=[native(0,"IN",5,a(10))];
  for(let i=0;i<24;i++)rows.push(native(DAY+i*MIN,"OUT",0.00005,a(2100+i)));
  // Identical amounts in one day also trip velocity and round-amount, each its own family.
  add("dust sprayed to 24 addresses",["ELEVATED"],["DUST_SPRAY","HIGH_VELOCITY","ROUND_AMOUNT_CLUSTER"],wallet(rows));
}

{
  const rows=[btc(0,"IN",4,"bc1qsender")];
  for(let i=0;i<6;i++)rows.push(btc(i*DAY,"SELF",3-i*0.1,"",{self_spend:true,fee:0.00001}));
  rows.push(btc(9*DAY,"OUT",1,"bc1qa"),btc(12*DAY,"OUT",0.5,"bc1qb"),btc(15*DAY,"OUT",0.25,"bc1qc"),btc(18*DAY,"IN",1,"bc1qd"));
  add("Bitcoin self-spends repeated within a week",["LOW"],["SELF_TRANSFER_CHURN"],bitcoin(rows));
}

add("the wallet itself is listed",["HIGH"],["LISTED_WALLET"],wallet([native(0,"IN",1,a(10))],{
  sanctions_screening:{status:"ok",hit:true,seed_match:{summary:"SYNTHETIC ENTITY [SDGT]"},counterparty_matches:[]}
}));

add("sent funds to a terrorism-programme address",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],wallet(
  [native(0,"IN",5,a(10)),native(DAY,"OUT",4,a(66))],hit(listed(a(66),{received_from_count:0,sent_to_count:1}))
));

add("real value received from a listed address stays HIGH",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],wallet(
  [...quiet(),native(15*DAY,"IN",2,a(66))],hit(listed(a(66)))
));

add("a listed exchange that is not a terrorism designation still gives HIGH",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],wallet(
  [...quiet(),native(15*DAY,"OUT",2,a(66))],
  hit(listed(a(66),{entities:[{name:"SYNTHETIC EXCHANGE",programs:["CYBER2"],terrorism:false}],received_from_count:0,sent_to_count:1}))
));

add("a failed send to a listed address stays HIGH and says no value moved",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],wallet(
  [...quiet(),native(15*DAY,"OUT",2,a(66),{failed:true})],hit(listed(a(66),{received_from_count:0,sent_to_count:1}))
));

add("spent in one transaction with a listed address",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],bitcoin(
  [btc(0,"IN",1,"bc1qsender"),btc(DAY,"OUT",0.9,"bc1qdest",{co_inputs:["3SyntheticListedInput"]})],
  hit(listed("3SyntheticListedInput",{received_from_count:0,spent_with_count:1}))
));

add("a listed output past the display cap still links the row",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE"],bitcoin(
  [btc(0,"IN",1,"bc1qsender"),btc(DAY,"OUT",0.9,"bc1qdest",{all_counterparties:[...Array.from({length:20},(_,i)=>"bc1qother"+i),"3SyntheticListedOutput"]})],
  hit(listed("3SyntheticListedOutput",{received_from_count:0,sent_to_count:1}))
));

add("direct deposit to a labelled mixer",["ELEVATED"],["DIRECT_MIXER_EXPOSURE"],wallet([
  native(0,"IN",5,a(10)),native(DAY,"OUT",1,a(77)),native(3*DAY,"OUT",1,a(77)),native(5*DAY,"OUT",1,a(77)),native(9*DAY,"OUT",1,a(11))
]),{labels:[{address:a(77),category:"MIXER",name:"Synthetic mixer"}]});

add("funds received from a labelled mixer also count",["ELEVATED"],["DIRECT_MIXER_EXPOSURE"],wallet([
  native(0,"IN",5,a(77)),native(DAY,"OUT",1,a(11)),native(3*DAY,"OUT",1,a(12)),native(5*DAY,"OUT",1,a(13)),native(9*DAY,"OUT",1,a(14))
]),{labels:[{address:a(77),category:"MIXER",name:"Synthetic mixer"}]});

add("withdrawal from a Tornado Cash pool in the built-in registry",["ELEVATED"],["DIRECT_MIXER_EXPOSURE"],wallet([
  native(0,"IN",10,"0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",{internal:true}),
  native(DAY,"OUT",1,a(11)),native(3*DAY,"OUT",1,a(12)),native(5*DAY,"OUT",1,a(13)),native(9*DAY,"OUT",1,a(14))
]));

add("a listed mixer gives both list and mixer findings",["HIGH"],["DIRECT_SANCTIONS_EXPOSURE","DIRECT_MIXER_EXPOSURE"],wallet(
  [...quiet(),native(15*DAY,"OUT",2,a(66))],
  hit(listed(a(66),{entities:[{name:"BLENDER.IO",programs:["CYBER2"],terrorism:false}],received_from_count:0,sent_to_count:1}))
));

add("a CoinJoin-like Bitcoin transaction",["ELEVATED"],["DIRECT_MIXER_EXPOSURE"],bitcoin([
  btc(0,"IN",1,"bc1qsender"),btc(DAY,"OUT",0.1,"bc1qmix",{coinjoin_like:true}),
  btc(9*DAY,"OUT",0.2,"bc1qa"),btc(19*DAY,"OUT",0.1,"bc1qb"),btc(29*DAY,"OUT",0.1,"bc1qc")
]));

{
  const rows=[];
  for(let i=0;i<12;i++){
    rows.push(btc(i*40*MIN,"IN",9000+i,"bc1qin"+i));
    rows.push(btc(i*40*MIN+10*MIN,"OUT",(9000+i)*0.99,"bc1qout"+i));
  }
  add("a 25-row Bitcoin sample can still reach the mule rule",["ELEVATED"],["RAPID_PASS_THROUGH"],bitcoin(rows.slice(0,24)));
}

add("Bitcoin single-use wallet takes a small slice off",["LOW"],["PEEL_STEP"],bitcoin([
  btc(0,"IN",2,"bc1qsender"),btc(3*HOUR,"OUT",2,"bc1qnext",{out_values:[1.9,0.1],outputs_count:2})
],{coverage:{complete:true,lifetime_tx_count:2}}));

add("a peel step is not read from an incomplete sample",["NOT_ASSESSED"],[],bitcoin([
  btc(0,"IN",2,"bc1qsender"),btc(3*HOUR,"OUT",2,"bc1qnext",{out_values:[1.9,0.1],outputs_count:2})
],{coverage:{complete:false,lifetime_tx_count:90}}));

{
  const rows=[btc(0,"IN",1,"bc1qsender")];
  const wide=Array.from({length:18},(_,i)=>"bc1qreceiver"+i);
  rows.push(btc(HOUR,"OUT",0.9,wide[0],{counterparties:wide.slice(0,12),all_counterparties:wide}));
  rows.push(btc(9*DAY,"IN",0.2,"bc1qa"),btc(19*DAY,"OUT",0.1,"bc1qb"),btc(29*DAY,"OUT",0.05,"bc1qc"));
  add("receivers past the display cap still count",["LOW"],["FAN_OUT"],bitcoin(rows));
}

const strongFamilies=()=>{
  const rows=[];
  for(let i=0;i<6;i++){
    rows.push(usdt(i*5*HOUR,"IN",9500+i,a(1400+i)));
    rows.push(usdt(i*5*HOUR+15*MIN,"OUT",9500+i-40,a(1500+(i%2))));
  }
  return rows;
};

add("three independent strong families together",["HIGH"],["RAPID_PASS_THROUGH","STRUCTURING_BAND","DORMANT_THEN_BURST"],wallet([
  native(-300*DAY,"IN",1,a(10)),native(-299*DAY,"OUT",1,a(11)),...strongFamilies()
]));

add("two strong families stay below HIGH without list evidence",["ELEVATED"],["RAPID_PASS_THROUGH","STRUCTURING_BAND"],wallet(strongFamilies()));

add("two strong families and a moderate third are capped below HIGH",["ELEVATED"],["RAPID_PASS_THROUGH","STRUCTURING_BAND","DORMANT_THEN_BURST"],wallet([
  native(-120*DAY,"IN",1,a(10)),native(-119*DAY,"OUT",1,a(11)),...strongFamilies()
]),{},{score:59});

module.exports={cases,wallet,native,usdt,a,USDT,DAY,HOUR,MIN};
