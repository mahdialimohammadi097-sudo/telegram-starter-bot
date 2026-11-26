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
