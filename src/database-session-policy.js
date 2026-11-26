// Startup options shared by all restricted pool connections and the operator audit.
// Keep legacy startup unchanged until separately authorized.
export function restrictedRuntimeConnectionOptions(env=process.env,{schema="public",force=false}={}){
  if(!force&&env.PROFINO_RUNTIME_SCHEMA_MODE!=="verify-only")return {};
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)){
    throw new Error("Invalid restricted runtime schema");
  }
  let url;
  try{url=new URL(env.DATABASE_URL??"postgresql://localhost");}
  catch{throw new Error("Invalid DATABASE_URL configuration");}
  // node-postgres connection-string settings can override explicit options.
  // Reject ambiguity instead of attempting to merge arbitrary startup commands.
  for(const key of url.searchParams.keys()){
    if(key.toLowerCase()==="options")throw new Error("Restricted runtime URL startup options conflict");
  }
  // Explicit pg_temp last prevents PostgreSQL's implicit temp-first lookup.
  return {options:"-c search_path=pg_catalog,"+schema+",pg_temp"};
}

// Verify each checked-out connection, including pool.query's callback path.
// Discard drifted clients, never silently repair or return them to the pool.
export function guardRestrictedPoolCheckouts(pool,{schema="public"}={}){
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)){
    throw new Error("Invalid restricted runtime schema");
  }
  const connect=pool.connect.bind(pool);
  async function checkedConnect(){
    const client=await connect();
    try{
      const {rows}=await client.query(`
        SELECT current_user=session_user AS same_role,
          pg_catalog.current_schemas(true)::text[]=ARRAY['pg_catalog'::text,$1::text] AS safe_path,
          pg_catalog.current_setting('session_replication_role')='origin' AS origin_mode
      `,[schema]);
      if(rows?.length!==1||rows[0].same_role!==true||rows[0].safe_path!==true||rows[0].origin_mode!==true){
        throw new Error("Restricted runtime connection settings incompatible");
      }
      return client;
    }catch{
      client.release(true);
      throw new Error("Restricted runtime connection settings incompatible");
    }
  }
  pool.connect=function(callback){
    const pending=checkedConnect();
    if(typeof callback!=="function")return pending;
    // pg.Pool.query obtains clients through the callback form.
    pending.then(client=>callback(null,client,client.release),error=>callback(error));
  };
  return pool;
}
