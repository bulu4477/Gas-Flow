module.exports = async function ( taskArgs, hre ) {
    const gasFlowStakeVault = await ethers.getContract( "GasFlowStakeVault" )
    const amount = "100000000000000000" 
    const depositTx = await gasFlowStakeVault.depositETH( 0, {value: amount} )
    await depositTx.wait()
    console.log( `>>> depositTx: ${ depositTx.hash }` )
}