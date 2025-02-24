from web3 import Web3
from eth_account import Account
from datetime import datetime
import time  # Added back for timestamp operations
import json
import os
import random
import logging
from logging.handlers import RotatingFileHandler
from dotenv import load_dotenv
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

# Load environment variables
load_dotenv()

def setup_logger():
    """Setup logging configuration"""
    if not os.path.exists('logs'):
        os.makedirs('logs')

    logger = logging.getLogger('DCAInvestment')
    logger.setLevel(logging.INFO)

    log_file = os.path.join('logs', 'dca_investment.log')
    file_handler = RotatingFileHandler(log_file, maxBytes=10*1024*1024, backupCount=5)
    
    console_handler = logging.StreamHandler()

    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(formatter)
    console_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger

logger = setup_logger()

class Web3Connection:
    def __init__(self, provider_uri):
        self.provider_uri = provider_uri
        self.w3 = None
        self.max_retries = 5
        self.base_delay = 5
        self.max_delay = 60
        self.connect()
    
    def connect(self):
        try:
            self.w3 = Web3(Web3.HTTPProvider(self.provider_uri))
            if self.w3.is_connected():
                logger.info(f"Successfully connected to EVM network: {self.w3.net.version}")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to initialize Web3 connection: {str(e)}")
            return False
    
    def ensure_connection(self):
        if self.w3 is None or not self.w3.is_connected():
            return self._reconnect()
        return True
    
    def _reconnect(self):
        for attempt in range(self.max_retries):
            logger.info(f"Attempting to reconnect (attempt {attempt + 1}/{self.max_retries})")
            delay = min(self.base_delay * (2 ** attempt) + random.uniform(0, 1), self.max_delay)
            logger.info(f"Waiting {delay:.2f} seconds before next attempt")
            time.sleep(delay)
            
            if self.connect():
                logger.info("Reconnection successful!")
                return True
                
        logger.error("Failed to reconnect after maximum attempts")
        return False
    
    def execute_with_retry(self, func, *args, **kwargs):
        for attempt in range(self.max_retries):
            try:
                if not self.ensure_connection():
                    raise Exception("Failed to ensure Web3 connection")
                    
                return func(*args, **kwargs)
                
            except Exception as e:
                if attempt < self.max_retries - 1:
                    logger.warning(f"Error during execution (attempt {attempt + 1}/{self.max_retries}): {str(e)}")
                    delay = min(self.base_delay * (2 ** attempt) + random.uniform(0, 1), self.max_delay)
                    logger.info(f"Retrying in {delay:.2f} seconds")
                    time.sleep(delay)
                else:
                    logger.error(f"Failed after {self.max_retries} attempts: {str(e)}")
                    raise

class DCAInvestment:
    def __init__(self, web3_manager, contract_address, private_key, batch_numbers):
        self.web3_manager = web3_manager
        self.contract_address = contract_address
        self.private_key = private_key
        self.batch_numbers = batch_numbers
        self.account = Account.from_key(private_key)
        
        # Load contract ABI
        with open('abi.json', 'r') as f:
            self.contract_abi = json.load(f)
        
        self.contract = self.web3_manager.w3.eth.contract(
            address=self.contract_address, 
            abi=self.contract_abi
        )

    def check_batch_usdc_balance(self, batch_number):
        """Check if users in the batch have sufficient USDC balance for investment"""
        try:
            # Get users info for the batch
            users_info = self.contract.functions.getUsersInfo(batch_number).call()
            
            total_available_usdc = 0
            sufficient_users = 0
            
            for user in users_info:
                balance = user[0]  # balance is the first field in User struct
                invest_amount = user[2]  # investAmount is the third field
                
                if balance >= invest_amount and invest_amount > 0:
                    sufficient_users += 1
                    total_available_usdc += invest_amount
            
            logger.info(f"Batch {batch_number} status:")
            logger.info(f"Total users with sufficient balance: {sufficient_users}/{len(users_info)}")
            logger.info(f"Total available USDC for investment: {total_available_usdc}")
            
            # Return True if at least one user has sufficient balance
            return sufficient_users > 0, total_available_usdc
            
        except Exception as e:
            logger.error(f"Error checking USDC balance for batch {batch_number}: {str(e)}")
            return False, 0

    def estimate_gas_for_batch(self, batch_number):
        """Estimate gas needed for executing investment for a specific batch"""
        try:
            # Build transaction for gas estimation
            transaction = self.contract.functions.executeInvestment(batch_number).build_transaction({
                'from': self.account.address,
                'nonce': self.web3_manager.w3.eth.get_transaction_count(self.account.address),
            })
            
            # Estimate gas
            estimated_gas = self.web3_manager.w3.eth.estimate_gas(transaction)
            logger.info(f"Estimated gas for batch {batch_number}: {estimated_gas}")
            return estimated_gas
            
        except Exception as e:
            logger.error(f"Error estimating gas for batch {batch_number}: {str(e)}")
            # Return a conservative estimate if estimation fails
            return 2000000

    def check_eth_balance(self):
        def _check():
            # Get current balance
            balance = self.web3_manager.w3.eth.get_balance(self.account.address)
            balance_in_eth = float(self.web3_manager.w3.from_wei(balance, 'ether'))
        
            # Get current gas price
            gas_price = self.web3_manager.w3.eth.gas_price
        
            # Only estimate gas for batches that are ready for investment
            total_estimated_gas = 0
            batch_gas_estimates = {}
        
            for batch_number in self.batch_numbers:
                try:
                    # Check if the batch is ready for investment
                    next_investment_time = self.contract.functions.batches(batch_number).call()
                    current_time = int(time.time())
                
                    if current_time >= next_investment_time:
                        # Only estimate gas if the interval has passed
                        has_sufficient_balance, _ = self.check_batch_usdc_balance(batch_number)
                        if has_sufficient_balance:
                            estimated_gas = self.estimate_gas_for_batch(batch_number)
                            batch_gas_estimates[batch_number] = estimated_gas
                            total_estimated_gas += estimated_gas
                    else:
                        logger.info(f"Skipping gas estimation for batch {batch_number}: Interval not passed")
                except Exception as e:
                    logger.error(f"Error checking batch {batch_number}: {str(e)}")
                    continue
        
            if not batch_gas_estimates:
                logger.info("No batches ready for investment, skipping further checks")
                return False
        
            total_estimated_cost = float(self.web3_manager.w3.from_wei(gas_price * total_estimated_gas, 'ether'))
        
            logger.info(f"Current ETH balance: {balance_in_eth:.4f} ETH")
            logger.info(f"Total estimated gas cost: {total_estimated_cost:.4f} ETH")
            logger.info("Gas estimates by batch:")
            for batch, gas in batch_gas_estimates.items():
                batch_cost = float(self.web3_manager.w3.from_wei(gas_price * gas, 'ether'))
                logger.info(f"Batch {batch}: {gas} gas ({batch_cost:.4f} ETH)")
        
            # Add 20% buffer for gas price fluctuations
            min_required_eth = float(total_estimated_cost * 1.2)
        
            if balance_in_eth < min_required_eth:
                logger.warning(f"Insufficient ETH balance for gas fees!")
                logger.warning(f"Required: {min_required_eth:.4f} ETH")
                logger.warning(f"Current: {balance_in_eth:.4f} ETH")
                logger.warning(f"Please add at least {(min_required_eth - balance_in_eth):.4f} ETH to continue")
                return False
            
            return True
    
        return self.web3_manager.execute_with_retry(_check)

    def check_and_execute_investment(self, batch_number):
        def _execute():
            try:
                # First check investment time
                next_investment_time = self.contract.functions.batches(batch_number).call()
                current_time = int(time.time())
            
                if current_time < next_investment_time:
                    logger.info(f"Batch {batch_number} next investment time not reached. Current: {datetime.fromtimestamp(current_time)}, Next: {datetime.fromtimestamp(next_investment_time)}")
                    return False
            
                # Then check if users have sufficient USDC balance
                has_sufficient_balance, total_usdc = self.check_batch_usdc_balance(batch_number)
                if not has_sufficient_balance:
                    logger.info(f"Skipping batch {batch_number}: No users with sufficient USDC balance")
                    return False

                logger.info(f"Batch {batch_number} is ready for investment at {datetime.fromtimestamp(current_time)}")
                logger.info(f"Total USDC to be invested: {total_usdc}")
            
                try:
                    # Get the latest nonce and gas price
                    nonce = self.web3_manager.w3.eth.get_transaction_count(self.account.address)
                    gas_price = self.web3_manager.w3.eth.gas_price
                
                    # Estimate gas for this specific transaction
                    estimated_gas = self.estimate_gas_for_batch(batch_number)
                
                    transaction = self.contract.functions.executeInvestment(batch_number).build_transaction({
                        'from': self.account.address,
                        'gas': int(estimated_gas * 1.1),  # Add 10% buffer to estimated gas
                        'gasPrice': gas_price,
                        'nonce': nonce,
                    })
                
                    signed_txn = self.web3_manager.w3.eth.account.sign_transaction(transaction, self.private_key)
                    tx_hash = self.web3_manager.w3.eth.send_raw_transaction(signed_txn.rawTransaction)
                    logger.info(f"Transaction sent for batch {batch_number}: {tx_hash.hex()}")
                
                    receipt = self.web3_manager.w3.eth.wait_for_transaction_receipt(tx_hash)
                    logger.info(f"Transaction for batch {batch_number} confirmed in block {receipt['blockNumber']}")
                    logger.info(f"Actual gas used: {receipt['gasUsed']}")
                
                    return True
                except Exception as e:
                    logger.error(f"Error executing investment for batch {batch_number}: {str(e)}")
                    return False
                
            except Exception as e:
                logger.error(f"Error processing batch {batch_number}: {str(e)}")
                return False
    
        return self.web3_manager.execute_with_retry(_execute)

    def process_all_batches(self):
        if not self.check_eth_balance():
            return

        for batch_number in self.batch_numbers:
            try:
                self.check_and_execute_investment(batch_number)
            except Exception as e:
                logger.error(f"Error processing batch {batch_number}: {str(e)}")
                continue

def process_investment(dca_investment):
    """Wrapper function for scheduler to call"""
    try:
        dca_investment.process_all_batches()
    except Exception as e:
        logger.error(f"Error in scheduled job: {str(e)}")

def main():
    # Get configuration from environment variables
    web3_provider_uri = os.getenv('WEB3_PROVIDER_URI','https://arb1.arbitrum.io/rpc')
    contract_address = os.getenv('CONTRACT_ADDRESS','0xA87619dEFaa9b63F5D78eA69a4fBAdEa7341347e')
    private_key = os.getenv('PRIVATE_KEY')
    
    # Get batch numbers from environment variable
    batch_numbers_str = os.getenv('BATCH_NUMBERS','1')
    batch_numbers = [int(x.strip()) for x in batch_numbers_str.split(',')]
    
    # Get cron schedule from environment variable, default to every 3 hours
    cron_schedule = os.getenv('CRON_SCHEDULE', '0 */3 * * *')
    
    web3_manager = Web3Connection(web3_provider_uri)
    dca_investment = DCAInvestment(web3_manager, contract_address, private_key, batch_numbers)
    
    logger.info(f"Starting investment monitor for batches: {batch_numbers}")
    logger.info(f"Using account: {dca_investment.account.address}")
    logger.info(f"Using cron schedule: {cron_schedule}")

    # Initialize the scheduler
    scheduler = BlockingScheduler()
    
    # Add the job with cron trigger
    scheduler.add_job(
        process_investment,
        CronTrigger.from_crontab(cron_schedule),
        args=[dca_investment],
        misfire_grace_time=3600,  # Allow job to be run up to 1 hour late
        coalesce=True,  # Only run once if multiple executions are missed
    )
    
    try:
        # Run the first check immediately
        process_investment(dca_investment)
        
        # Start the scheduler
        logger.info("Starting scheduler...")
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped by user")
        scheduler.shutdown()
    except Exception as e:
        logger.error(f"Scheduler error: {str(e)}")
        scheduler.shutdown()

if __name__ == "__main__":
    main()