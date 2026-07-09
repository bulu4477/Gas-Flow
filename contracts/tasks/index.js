const { task } = require( "hardhat/config" )

task( "setPriceFeed", require( "./setPriceFeed" ) )

task( "addRelayer", require( "./addRelayer" ) )

task( "deposit", require( "./deposit" ) )
